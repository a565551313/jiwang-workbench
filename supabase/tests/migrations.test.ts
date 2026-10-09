import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyMigrations, createTestDatabase, migrationFiles, useSession } from './helpers/database'

const SETUP_TIMEOUT = 120_000
let db: PGlite

beforeAll(async () => {
  db = await createTestDatabase()
}, SETUP_TIMEOUT)

afterAll(async () => {
  await db?.close()
})

describe('数据库迁移链', () => {
  it('按文件名顺序从空库执行全部迁移', () => {
    expect(migrationFiles()).toEqual([
      '20261008070000_initial.sql',
      '20261008073000_admin_console.sql',
      '20261008090000_multi_model_billing.sql',
      '20261008103000_provider_model_settings.sql',
      '20261008120000_generation_recovery.sql',
      '20261008130000_retention_and_quotas.sql',
      '20261009100000_theme_presets.sql',
      '20261009110000_enforce_signup_switch.sql',
    ])
  })

  it('最终结构包含按尝试记账、部分交付和超时回收所需的对象', async () => {
    const columns = await db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'generation_jobs'",
    )
    const names = columns.rows.map((row) => row.column_name)
    expect(names).toEqual(expect.arrayContaining(['attempt', 'completed_count', 'queued_at', 'worker_token']))

    const functions = await db.query<{ proname: string }>(
      "select proname from pg_proc join pg_namespace n on n.oid = pronamespace where n.nspname = 'public'",
    )
    const functionNames = new Set(functions.rows.map((row) => row.proname))
    for (const name of [
      'worker_reap_stale_generations',
      'worker_begin_retry',
      'worker_complete_generation',
      'worker_update_generation_progress',
      'worker_get_image_provider_api_key',
      'public_site_features',
      'worker_create_generation_job',
      'worker_expired_reference_images',
      'worker_delete_reference_rows',
      'enable_scheduled_cleanup',
      'worker_cleanup_secret_matches',
      'public_theme_presets',
      'enforce_signup_switch',
    ]) {
      expect(functionNames.has(name), name).toBe(true)
    }
    // 旧的单参数密钥读取函数必须被删除，避免绕过 Base URL 绑定。
    const legacyKeyReaders = await db.query<{ n: number }>(
      "select count(*)::int as n from pg_proc join pg_namespace n on n.oid = pronamespace where n.nspname = 'public' and proname = 'worker_get_image_provider_api_key' and pronargs = 1",
    )
    expect(legacyKeyReaders.rows[0]?.n).toBe(0)
  })

  it('主题预设：匿名只能经由只读 RPC 读取，不能直接读取后台设置', async () => {
    await useSession(db, 'postgres')
    await db.query("delete from public.admin_settings where setting_key = 'themePresets'")

    await useSession(db, 'anon')
    const unset = await db.query<{ value: unknown }>('select public.public_theme_presets() as value')
    expect(unset.rows[0]!.value).toBeNull()
    await expect(db.query('select setting_key from public.admin_settings')).rejects.toThrow(/permission denied/)

    await useSession(db, 'postgres')
    const presets = [{ label: '测试分类', themes: [{ name: '测试主题', cells: [] }] }]
    await db.query(
      "insert into public.admin_settings (setting_key, value) values ('themePresets', $1::jsonb) on conflict (setting_key) do update set value = excluded.value",
      [JSON.stringify(presets)],
    )

    await useSession(db, 'anon')
    const published = await db.query<{ value: unknown }>('select public.public_theme_presets() as value')
    expect(published.rows[0]!.value).toEqual(presets)
    await expect(db.query("select public.worker_get_image_provider_api_key(gen_random_uuid(), 'https://x.example')")).rejects.toThrow(/permission denied/)

    await useSession(db, 'authenticated', { userId: '22222222-2222-4222-8222-222222222222' })
    const asUser = await db.query<{ value: unknown }>('select public.public_theme_presets() as value')
    expect(asUser.rows[0]!.value).toEqual(presets)
    await useSession(db, 'postgres')
  })

  it('后台关闭邮箱注册后，数据库拒绝新用户插入；开启或未设置时允许', async () => {
    await useSession(db, 'postgres')
    const setFeatures = async (features: Record<string, unknown> | null) => {
      await db.query("delete from public.admin_settings where setting_key = 'features'")
      if (features) {
        await db.query("insert into public.admin_settings (setting_key, value) values ('features', $1::jsonb)", [JSON.stringify(features)])
      }
    }
    const tryInsert = (email: string) => db.query('insert into auth.users (id, email) values (gen_random_uuid(), $1)', [email])

    await setFeatures({ signup: false, customThemes: true, maintenance: false })
    await expect(tryInsert('closed-signup@example.invalid')).rejects.toThrow('当前暂未开放注册')

    await setFeatures({ signup: true, customThemes: true, maintenance: false })
    await expect(tryInsert('open-signup@example.invalid')).resolves.toBeDefined()

    // 未设置 signup 字段时与 public_site_features 一致，视为开启。
    await setFeatures({ customThemes: true })
    await expect(tryInsert('default-signup@example.invalid')).resolves.toBeDefined()

    await setFeatures(null)
  })

  it('升级旧库时 queued_at 沿用任务创建时间，不重置参考图保留期限', async () => {
    const upgradeDb = await createTestDatabase({ throughFile: '20261008103000_provider_model_settings.sql' })
    try {
      const userId = '11111111-1111-4111-8111-111111111111'
      const createdAt = '2025-01-02T03:04:05.000Z'
      await upgradeDb.query('insert into auth.users (id, email) values ($1, $2)', [userId, 'migration-test@example.invalid'])
      await upgradeDb.query(
        'insert into public.generation_jobs (user_id, status, created_at) values ($1, $2, $3)',
        [userId, 'failed', createdAt],
      )

      await applyMigrations(upgradeDb, [
        '20261008120000_generation_recovery.sql',
        '20261008130000_retention_and_quotas.sql',
      ])

      const { rows } = await upgradeDb.query<{ created_at: string; queued_at: string }>(
        'select created_at, queued_at from public.generation_jobs where user_id = $1', [userId],
      )
      expect(new Date(rows[0]!.queued_at).toISOString()).toBe(new Date(rows[0]!.created_at).toISOString())
      expect(new Date(rows[0]!.queued_at).toISOString()).toBe(createdAt)
    } finally {
      await upgradeDb.close()
    }
  })
})
