import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, migrationFiles } from './helpers/database'

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
    ]) {
      expect(functionNames.has(name), name).toBe(true)
    }
    // 旧的单参数密钥读取函数必须被删除，避免绕过 Base URL 绑定。
    const legacyKeyReaders = await db.query<{ n: number }>(
      "select count(*)::int as n from pg_proc join pg_namespace n on n.oid = pronamespace where n.nspname = 'public' and proname = 'worker_get_image_provider_api_key' and pronargs = 1",
    )
    expect(legacyKeyReaders.rows[0]?.n).toBe(0)
  })
})
