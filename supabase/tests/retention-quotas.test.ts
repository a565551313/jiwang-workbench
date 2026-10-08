// 参考图保留期限、同时进行中上限、每日开始次数上限的回归测试（PGlite，真实迁移）。
import { randomUUID } from 'node:crypto'
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, useSession } from './helpers/database'

const SETUP_TIMEOUT = 120_000
let db: PGlite

beforeAll(async () => {
  db = await createTestDatabase()
}, SETUP_TIMEOUT)

afterAll(async () => {
  await db?.close()
})

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

async function service() {
  await useSession(db, 'service_role')
}

/** Seed data as the migration owner so fixtures are not constrained by RLS or grants. */
async function owner() {
  await useSession(db, 'postgres')
}

async function createUser(): Promise<string> {
  await owner()
  const id = randomUUID()
  await db.query('insert into auth.users (id, email) values ($1, $2)', [id, `${id}@test.local`])
  return id
}

/** A reference photo uploaded `daysOld` days ago. Returns its storage path. */
async function createReference(userId: string, daysOld: number): Promise<string> {
  await owner()
  const path = `${userId}/references/${randomUUID()}.png`
  await db.query(
    `insert into public.assets (user_id, kind, name, storage_path, mime_type, created_at)
     values ($1, 'reference', '角色图', $2, 'image/png', now() - make_interval(days => $3::int))`,
    [userId, path, daysOld],
  )
  return path
}

/** Insert a job row directly (fixture). `createdDaysAgo` moves it into the past. */
async function createJobRow(
  userId: string,
  referencePath: string,
  options: { status?: string; createdDaysAgo?: number; price?: number } = {},
): Promise<string> {
  await owner()
  const id = randomUUID()
  await db.query(
    `insert into public.generation_jobs
       (id, user_id, status, title, topic, options, model_id, model_name, price_coins, reference_path, progress,
        client_request_id, created_at, queued_at)
     values ($1, $2, $3, '测试套装', '测试主题', '{"cellCount":16}'::jsonb, $4, 'test-model', $5, $6, 0, $1,
             now() - make_interval(days => $7::int), now() - make_interval(days => $7::int))`,
    [id, userId, options.status ?? 'completed', randomUUID(), options.price ?? 40, referencePath, options.createdDaysAgo ?? 0],
  )
  return id
}

/** Start a job through the same server function the Edge Function uses. */
async function startJob(userId: string, referencePath: string, price = 40): Promise<string> {
  await service()
  const id = randomUUID()
  await db.query('select public.worker_create_generation_job($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)', [
    id,
    userId,
    '测试套装',
    '测试主题',
    randomUUID(),
    'test-model',
    price,
    referencePath,
    '{"cellCount":16}',
  ])
  return id
}

async function retry(jobId: string, price = 40) {
  await service()
  await db.query('select public.worker_begin_retry($1, $2, $3)', [jobId, 'test-model', price])
}

async function setStatus(jobId: string, status: string) {
  await owner()
  await db.query('update public.generation_jobs set status = $2 where id = $1', [jobId, status])
}

async function statusOf(jobId: string): Promise<string> {
  await owner()
  const { rows } = await db.query<{ status: string }>('select status from public.generation_jobs where id = $1', [jobId])
  return rows[0]?.status ?? ''
}

async function jobCount(userId: string): Promise<number> {
  await owner()
  const { rows } = await db.query<{ count: string }>('select count(*) as count from public.generation_jobs where user_id = $1', [userId])
  return Number(rows[0]?.count ?? 0)
}

async function startsToday(userId: string): Promise<number> {
  await owner()
  const { rows } = await db.query<{ starts: number }>(
    'select starts from public.generation_daily_usage where user_id = $1 and usage_date = public.generation_day_key()',
    [userId],
  )
  return Number(rows[0]?.starts ?? 0)
}

// ---------------------------------------------------------------------------
// 同时进行中的任务上限（最多 2 套）
// ---------------------------------------------------------------------------

describe('同时进行中的任务上限', () => {
  it('同一用户最多同时进行 2 套，第 3 套被拒绝且不建任务、不计数', async () => {
    const user = await createUser()
    const reference = await createReference(user, 0)
    await startJob(user, reference)
    await startJob(user, reference)
    await expect(startJob(user, reference)).rejects.toThrow('generation_quota_concurrent')
    expect(await jobCount(user)).toBe(2)
    expect(await startsToday(user)).toBe(2)
  })

  it('processing 状态同样占用名额', async () => {
    const user = await createUser()
    const reference = await createReference(user, 0)
    await createJobRow(user, reference, { status: 'processing' })
    await startJob(user, reference)
    await expect(startJob(user, reference)).rejects.toThrow('generation_quota_concurrent')
  })

  it('任务完成或失败后释放名额', async () => {
    const user = await createUser()
    const reference = await createReference(user, 0)
    const first = await startJob(user, reference)
    await startJob(user, reference)
    await setStatus(first, 'completed')
    await startJob(user, reference)
    await expect(startJob(user, reference)).rejects.toThrow('generation_quota_concurrent')
  })

  it('其他用户不受影响', async () => {
    const busy = await createUser()
    const busyReference = await createReference(busy, 0)
    await startJob(busy, busyReference)
    await startJob(busy, busyReference)
    const other = await createUser()
    const otherReference = await createReference(other, 0)
    await expect(startJob(other, otherReference)).resolves.toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 每日开始次数（北京时间自然日，最多 10 套，重新生成也计入）
// ---------------------------------------------------------------------------

describe('每日开始次数上限', () => {
  it('每日计数按北京时间划分（而不是 UTC）', async () => {
    await owner()
    const { rows } = await db.query<{ day: string }>('select public.generation_day_key()::text as day')
    const beijingToday = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
    expect(rows[0]?.day).toBe(beijingToday)
  })

  it('当日最多开始 10 套；第 11 套被拒绝，且不留下多余计数', async () => {
    const user = await createUser()
    const reference = await createReference(user, 0)
    for (let index = 0; index < 10; index += 1) {
      const id = await startJob(user, reference)
      await setStatus(id, 'completed')
    }
    await expect(startJob(user, reference)).rejects.toThrow('generation_quota_daily')
    expect(await startsToday(user)).toBe(10)
    expect(await jobCount(user)).toBe(10)
  })

  it('重新生成也计入当日次数，超过上限时不会开始也不扣费', async () => {
    const user = await createUser()
    const reference = await createReference(user, 0)
    for (let index = 0; index < 9; index += 1) {
      const id = await startJob(user, reference)
      await setStatus(id, 'completed')
    }
    const failed = await startJob(user, reference)
    await setStatus(failed, 'failed')
    await expect(retry(failed)).rejects.toThrow('generation_quota_daily')
    expect(await statusOf(failed)).toBe('failed')
    expect(await startsToday(user)).toBe(10)
  })

  it('重新生成在额度内正常开始，并计入次数', async () => {
    const user = await createUser()
    const reference = await createReference(user, 0)
    const failed = await createJobRow(user, reference, { status: 'failed' })
    await retry(failed)
    expect(await statusOf(failed)).toBe('queued')
    expect(await startsToday(user)).toBe(1)
  })

  it('重新生成同样受同时进行中上限限制', async () => {
    const user = await createUser()
    const reference = await createReference(user, 0)
    const failed = await createJobRow(user, reference, { status: 'failed' })
    await startJob(user, reference)
    await startJob(user, reference)
    await expect(retry(failed)).rejects.toThrow('generation_quota_concurrent')
    expect(await statusOf(failed)).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// 参考图保留期限
// ---------------------------------------------------------------------------

describe('参考图保留期限', () => {
  it('参考图已被删除（或不属于该用户）时不能创建任务，也不计数', async () => {
    const user = await createUser()
    const other = await createUser()
    const otherReference = await createReference(other, 0)
    await expect(startJob(user, `${user}/references/missing.png`)).rejects.toThrow('generation_reference_missing')
    await expect(startJob(user, otherReference)).rejects.toThrow('generation_reference_missing')
    expect(await jobCount(user)).toBe(0)
    expect(await startsToday(user)).toBe(0)
  })

  it('找出过期参考图：未使用超过 7 天，或最后一次使用超过 30 天；最近仍在使用的保留', async () => {
    const user = await createUser()
    const unusedOld = await createReference(user, 8)
    await createReference(user, 6)
    const usedLongAgo = await createReference(user, 40)
    await createJobRow(user, usedLongAgo, { createdDaysAgo: 31 })
    const usedRecently = await createReference(user, 40)
    await createJobRow(user, usedRecently, { createdDaysAgo: 29 })
    const usedBoth = await createReference(user, 40)
    await createJobRow(user, usedBoth, { createdDaysAgo: 31 })
    await createJobRow(user, usedBoth, { createdDaysAgo: 2 })

    await service()
    const { rows } = await db.query<{ result_storage_path: string }>(
      'select result_storage_path from public.worker_expired_reference_images(1000) where result_user_id = $1',
      [user],
    )
    expect(rows.map((row) => row.result_storage_path).sort()).toEqual([unusedOld, usedLongAgo].sort())
  })

  it('删除参考图记录只影响指定路径，任务记录保留', async () => {
    const user = await createUser()
    const unusedOld = await createReference(user, 8)
    const unusedRecent = await createReference(user, 2)
    const usedLongAgo = await createReference(user, 40)
    const job = await createJobRow(user, usedLongAgo, { createdDaysAgo: 31 })

    await service()
    const { rows } = await db.query<{ deleted: string }>('select public.worker_delete_reference_rows($1::text[]) as deleted', [
      `{${[unusedOld, usedLongAgo].join(',')}}`,
    ])
    expect(Number(rows[0]?.deleted)).toBe(2)

    await owner()
    const remaining = await db.query<{ storage_path: string }>(
      "select storage_path from public.assets where user_id = $1 and kind = 'reference'",
      [user],
    )
    expect(remaining.rows.map((row) => row.storage_path)).toEqual([unusedRecent])
    expect(await statusOf(job)).toBe('completed')
  })

  it('参考图记录被删除后，不能再用它重新生成', async () => {
    const user = await createUser()
    const usedLongAgo = await createReference(user, 40)
    const failed = await createJobRow(user, usedLongAgo, { status: 'failed', createdDaysAgo: 31 })
    await service()
    await db.query('select public.worker_delete_reference_rows($1::text[])', [`{${usedLongAgo}}`])
    await expect(startJob(user, usedLongAgo)).rejects.toThrow('generation_reference_missing')
    expect(await statusOf(failed)).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// 权限与定时清理的前置检查
// ---------------------------------------------------------------------------

describe('权限与定时清理设置', () => {
  it('普通用户不能读取计数表，也不能调用服务端函数', async () => {
    const user = await createUser()
    const reference = await createReference(user, 0)
    await useSession(db, 'authenticated', { userId: user })
    await expect(db.query('select * from public.generation_daily_usage')).rejects.toThrow(/permission denied/)
    await expect(db.query('select * from public.worker_expired_reference_images(10)')).rejects.toThrow(/permission denied/)
    await expect(db.query('select public.worker_delete_reference_rows($1::text[])', ['{}'])).rejects.toThrow(/permission denied/)
    await expect(
      db.query('select public.worker_create_generation_job($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)', [
        randomUUID(),
        user,
        '测试',
        '测试',
        randomUUID(),
        'test-model',
        40,
        reference,
        '{}',
      ]),
    ).rejects.toThrow(/permission denied/)
    await expect(db.query('select public.enable_scheduled_cleanup()')).rejects.toThrow(/permission denied/)
  })

  it('匿名用户同样不能调用清理函数', async () => {
    await useSession(db, 'anon')
    await expect(db.query('select * from public.worker_expired_reference_images(10)')).rejects.toThrow(/permission denied/)
    await expect(db.query('select public.worker_begin_retry($1, $2, $3)', [randomUUID(), 'x', 40])).rejects.toThrow(/permission denied/)
  })

  it('启用定时清理前必须先在 Vault 中保存项目网址和至少 32 位的清理口令', async () => {
    await owner()
    await expect(db.query('select public.enable_scheduled_cleanup()')).rejects.toThrow('jiwang_project_url')
    await db.query('select vault.create_secret($1, $2)', ['https://example.supabase.co', 'jiwang_project_url'])
    await expect(db.query('select public.enable_scheduled_cleanup()')).rejects.toThrow('jiwang_cleanup_secret')
    await db.query('select vault.create_secret($1, $2)', ['too-short', 'jiwang_cleanup_secret'])
    await expect(db.query('select public.enable_scheduled_cleanup()')).rejects.toThrow('jiwang_cleanup_secret')
  })

  it('清理口令只有完全一致且不少于 32 位时才通过校验', async () => {
    const secret = 'c1f0e2d3b4a5968778695a4b3c2d1e0f'.repeat(2)
    await owner()
    await db.query('select vault.update_secret(id, $1) from vault.secrets where name = $2', [secret, 'jiwang_cleanup_secret'])
    await service()
    const check = async (candidate: string) => {
      const { rows } = await db.query<{ ok: boolean }>('select public.worker_cleanup_secret_matches($1) as ok', [candidate])
      return rows[0]?.ok
    }
    expect(await check(secret)).toBe(true)
    expect(await check(secret.slice(0, -1) + '0')).toBe(false)
    expect(await check('')).toBe(false)
    await useSession(db, 'anon')
    await expect(db.query('select public.worker_cleanup_secret_matches($1)', [secret])).rejects.toThrow(/permission denied/)
  })

  it('口令过短时即使输入相同也不通过校验', async () => {
    await owner()
    await db.query('select vault.update_secret(id, $1) from vault.secrets where name = $2', ['short-secret', 'jiwang_cleanup_secret'])
    await service()
    const { rows } = await db.query<{ ok: boolean }>('select public.worker_cleanup_secret_matches($1) as ok', ['short-secret'])
    expect(rows[0]?.ok).toBe(false)
  })
})
