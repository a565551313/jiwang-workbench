// 针对真实迁移中的计费、恢复、权限与密钥绑定函数的回归测试（PGlite）。
import { randomUUID } from 'node:crypto'
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyMigrations, createTestDatabase, useSession } from './helpers/database'

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

/** Seed data as the migration owner so fixtures are not constrained by RLS or column grants. */
async function owner() {
  await useSession(db, 'postgres')
}

async function createUser(): Promise<string> {
  await owner()
  const id = randomUUID()
  await db.query('insert into auth.users (id, email) values ($1, $2)', [id, `${id}@test.local`])
  return id
}

async function setBalance(userId: string, balance: number) {
  await owner()
  await db.query(
    'insert into public.wallet_balances (user_id, balance) values ($1, $2) on conflict (user_id) do update set balance = excluded.balance',
    [userId, balance],
  )
}

async function balanceOf(userId: string): Promise<number> {
  const { rows } = await db.query<{ balance: string }>('select balance from public.wallet_balances where user_id = $1', [userId])
  return Number(rows[0]?.balance ?? 0)
}

async function createJob(userId: string, price: number, options: { status?: string; workerStartedMinutesAgo?: number; queuedMinutesAgo?: number } = {}): Promise<string> {
  await owner()
  const id = randomUUID()
  await db.query(
    `insert into public.generation_jobs
       (id, user_id, status, title, topic, options, model_id, model_name, price_coins, reference_path, progress, client_request_id, queued_at, worker_started_at)
     values ($1, $2, $3, '测试套装', '测试主题', '{"cellCount":16}'::jsonb, $4, 'test-model', $5, $6, 0, $1,
             now() - make_interval(mins => $7::int), case when $8::int is null then null else now() - make_interval(mins => $8::int) end)`,
    [
      id,
      userId,
      options.status ?? 'queued',
      randomUUID(),
      price,
      `${userId}/references/${id}.png`,
      options.queuedMinutesAgo ?? 0,
      options.workerStartedMinutesAgo ?? null,
    ],
  )
  return id
}

async function claim(jobId: string): Promise<string> {
  const token = randomUUID()
  await service()
  const { rows } = await db.query<{ worker_claim_generation: boolean }>('select public.worker_claim_generation($1, $2)', [jobId, token])
  expect(rows[0]?.worker_claim_generation).toBe(true)
  return token
}

async function reserve(jobId: string, token: string): Promise<number> {
  await service()
  const { rows } = await db.query<{ worker_reserve_generation_coins: string }>('select public.worker_reserve_generation_coins($1, $2)', [jobId, token])
  return Number(rows[0]?.worker_reserve_generation_coins)
}

async function addStickers(userId: string, jobId: string, cells: number[]) {
  await owner()
  for (const cell of cells) {
    await db.query(
      `insert into public.assets (user_id, job_id, kind, name, storage_path, mime_type, cell_index, caption)
       values ($1, $2, 'sticker', $3, $4, 'image/png', $5, $3)`,
      [userId, jobId, `表情 ${cell + 1}`, `${userId}/jobs/${jobId}/${String(cell + 1).padStart(2, '0')}.png`, cell],
    )
  }
}

async function complete(jobId: string, token: string) {
  await service()
  const { rows } = await db.query<{ result_status: string; result_delivered: number; result_refunded: number }>(
    'select * from public.worker_complete_generation($1, $2, null)',
    [jobId, token],
  )
  return rows[0]!
}

async function failJob(jobId: string, token: string, message = 'upstream failed') {
  await service()
  await db.query('select public.worker_fail_generation($1, $2, $3)', [jobId, token, message])
}

async function jobState(jobId: string) {
  await service()
  const { rows } = await db.query<{ status: string; completed_count: number; attempt: number; progress: number; error_message: string | null; worker_token: string | null }>(
    'select status, completed_count, attempt, progress, error_message, worker_token from public.generation_jobs where id = $1',
    [jobId],
  )
  return rows[0]!
}

async function ledger(jobId: string) {
  await service()
  const { rows } = await db.query<{ transaction_type: string; attempt: number; amount: number }>(
    'select transaction_type, attempt, amount from public.wallet_transactions where generation_job_id = $1 order by created_at, transaction_type',
    [jobId],
  )
  return rows
}

// ---------------------------------------------------------------------------
// 按尝试记账的重试
// ---------------------------------------------------------------------------

describe('按尝试记账的重试', () => {
  it('失败退款后，重新生成作为新尝试再次预扣，不会被旧退款挡住', async () => {
    const user = await createUser()
    await setBalance(user, 100)
    const job = await createJob(user, 60)

    const first = await claim(job)
    expect(await reserve(job, first)).toBe(40)
    await failJob(job, first, '上游 503')
    expect(await balanceOf(user)).toBe(100)
    expect((await jobState(job)).status).toBe('failed')

    await service()
    const { rows: attemptRows } = await db.query<{ attempt: number }>(
      'select public.worker_begin_retry($1, $2, $3) as attempt', [job, 'test-model', 60],
    )
    expect(attemptRows[0]?.attempt).toBe(2)
    const retry = await claim(job)
    expect(await reserve(job, retry)).toBe(40)
    await addStickers(user, job, Array.from({ length: 16 }, (_, index) => index))
    const result = await complete(job, retry)
    expect(result).toMatchObject({ result_status: 'completed', result_delivered: 16, result_refunded: 0 })

    expect(await balanceOf(user)).toBe(40)
    expect(await ledger(job)).toEqual([
      { transaction_type: 'generation_charge', attempt: 1, amount: -60 },
      { transaction_type: 'generation_refund', attempt: 1, amount: 60 },
      { transaction_type: 'generation_charge', attempt: 2, amount: -60 },
    ])
  })

  it('同一尝试重复预扣只扣一次', async () => {
    const user = await createUser()
    await setBalance(user, 100)
    const job = await createJob(user, 30)
    const token = await claim(job)
    expect(await reserve(job, token)).toBe(70)
    expect(await reserve(job, token)).toBe(70)
    expect(await balanceOf(user)).toBe(70)
  })

  it('只有失败的任务可以开始重试', async () => {
    const user = await createUser()
    await setBalance(user, 100)
    const job = await createJob(user, 10)
    await service()
    await expect(db.query('select public.worker_begin_retry($1, $2, $3)', [job, 'm', 10])).rejects.toThrow(/only failed generation jobs can be retried/)
  })
})

// ---------------------------------------------------------------------------
// 部分交付结算
// ---------------------------------------------------------------------------

describe('部分交付结算', () => {
  it('按交付张数比例结算，未交付部分退回，已生成图片保留', async () => {
    const user = await createUser()
    await setBalance(user, 100)
    const job = await createJob(user, 60)
    const token = await claim(job)
    await reserve(job, token)
    await addStickers(user, job, Array.from({ length: 13 }, (_, index) => index))

    const result = await complete(job, token)
    // 应收 = ceil(60 × 13 ÷ 16) = 49，退回 11
    expect(result).toMatchObject({ result_status: 'partial', result_delivered: 13, result_refunded: 11 })
    expect(await balanceOf(user)).toBe(51)
    const state = await jobState(job)
    expect(state).toMatchObject({ status: 'partial', completed_count: 13, progress: 100, worker_token: null })
    expect(state.error_message).toContain('已交付 13/16 张')
  })

  it('交付 1 张时按向上取整保留费用：60 汪币仅保留 4 汪币', async () => {
    const user = await createUser()
    await setBalance(user, 100)
    const job = await createJob(user, 60)
    const token = await claim(job)
    await reserve(job, token)
    await addStickers(user, job, [7])
    const result = await complete(job, token)
    expect(result).toMatchObject({ result_status: 'partial', result_delivered: 1, result_refunded: 56 })
    expect(await balanceOf(user)).toBe(96)
  })

  it('满 16 张时保留全部预扣，结算结果与单价一致', async () => {
    const user = await createUser()
    await setBalance(user, 100)
    const job = await createJob(user, 60)
    const token = await claim(job)
    await reserve(job, token)
    await addStickers(user, job, Array.from({ length: 16 }, (_, index) => index))
    expect(await complete(job, token)).toMatchObject({ result_status: 'completed', result_refunded: 0 })
    expect(await balanceOf(user)).toBe(40)
  })

  it('一张都没有交付时全额退款并标记失败', async () => {
    const user = await createUser()
    await setBalance(user, 100)
    const job = await createJob(user, 60)
    const token = await claim(job)
    await reserve(job, token)
    expect(await complete(job, token)).toMatchObject({ result_status: 'failed', result_delivered: 0, result_refunded: 60 })
    expect(await balanceOf(user)).toBe(100)
    expect((await jobState(job)).status).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// 超时回收
// ---------------------------------------------------------------------------

describe('超时回收', () => {
  it('超时的处理中任务按已交付张数结算，重复回收不会重复退款', async () => {
    const user = await createUser()
    await setBalance(user, 100)
    const job = await createJob(user, 60)
    const token = await claim(job)
    await reserve(job, token)
    await addStickers(user, job, Array.from({ length: 8 }, (_, index) => index))
    await db.query("update public.generation_jobs set worker_started_at = now() - interval '20 minutes' where id = $1", [job])

    await service()
    const first = await db.query<{ result_job_id: string; result_status: string; result_refunded: number }>(
      'select * from public.worker_reap_stale_generations(10, 50)',
    )
    const reaped = first.rows.find((row) => row.result_job_id === job)
    expect(reaped).toMatchObject({ result_status: 'partial', result_refunded: 30 })
    expect(await balanceOf(user)).toBe(70)

    const second = await db.query<{ result_job_id: string }>('select * from public.worker_reap_stale_generations(10, 50)')
    expect(second.rows.some((row) => row.result_job_id === job)).toBe(false)
    expect(await balanceOf(user)).toBe(70)
  })

  it('未超时的处理中任务不会被回收', async () => {
    const user = await createUser()
    await setBalance(user, 100)
    const job = await createJob(user, 60)
    const token = await claim(job)
    await reserve(job, token)
    await service()
    const { rows } = await db.query<{ result_job_id: string }>('select * from public.worker_reap_stale_generations(10, 50)')
    expect(rows.some((row) => row.result_job_id === job)).toBe(false)
    expect(await balanceOf(user)).toBe(40)
    expect((await jobState(job)).status).toBe('processing')
  })

  it('超时且没有任何图片的任务全额退款', async () => {
    const user = await createUser()
    await setBalance(user, 100)
    const job = await createJob(user, 60)
    const token = await claim(job)
    await reserve(job, token)
    await db.query("update public.generation_jobs set worker_started_at = now() - interval '30 minutes' where id = $1", [job])
    await service()
    const { rows } = await db.query<{ result_job_id: string; result_status: string; result_refunded: number }>('select * from public.worker_reap_stale_generations(10, 50)')
    expect(rows.find((row) => row.result_job_id === job)).toMatchObject({ result_status: 'failed', result_refunded: 60 })
    expect(await balanceOf(user)).toBe(100)
  })

  it('超时的排队任务直接结束，且因为从未预扣所以不退款', async () => {
    const user = await createUser()
    await setBalance(user, 100)
    const job = await createJob(user, 60, { queuedMinutesAgo: 30 })
    await service()
    const { rows } = await db.query<{ result_job_id: string; result_status: string; result_refunded: number }>('select * from public.worker_reap_stale_generations(10, 50)')
    expect(rows.find((row) => row.result_job_id === job)).toMatchObject({ result_status: 'failed', result_refunded: 0 })
    expect(await balanceOf(user)).toBe(100)
    expect((await jobState(job)).status).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// Edge Function 调用守卫
// ---------------------------------------------------------------------------

describe('服务端调用守卫', () => {
  it('worker 令牌不匹配时不能预扣、结算或失败', async () => {
    const user = await createUser()
    await setBalance(user, 100)
    const job = await createJob(user, 60)
    const token = await claim(job)
    const wrong = randomUUID()
    await service()
    await expect(db.query('select public.worker_reserve_generation_coins($1, $2)', [job, wrong])).rejects.toThrow(/claim is invalid/)
    await expect(db.query('select * from public.worker_complete_generation($1, $2, null)', [job, wrong])).rejects.toThrow(/claim is invalid/)
    await expect(db.query('select public.worker_fail_generation($1, $2, $3)', [job, wrong, 'x'])).rejects.toThrow(/claim is invalid/)
    expect(await reserve(job, token)).toBe(40)
  })

  it('失败回调是幂等的，已结算的任务不能再次失败', async () => {
    const user = await createUser()
    await setBalance(user, 100)
    const job = await createJob(user, 60)
    const token = await claim(job)
    await reserve(job, token)
    await failJob(job, token)
    await failJob(job, token)
    expect(await balanceOf(user)).toBe(100)

    const done = await createJob(user, 10)
    const doneToken = await claim(done)
    await reserve(done, doneToken)
    await addStickers(user, done, Array.from({ length: 16 }, (_, index) => index))
    await complete(done, doneToken)
    await service()
    await expect(db.query('select public.worker_fail_generation($1, $2, $3)', [done, doneToken, 'late'])).rejects.toThrow(/already settled/)
  })

  it('anon 和 authenticated 不能调用任何 worker 函数', async () => {
    const user = await createUser()
    const job = await createJob(user, 10)
    for (const role of ['anon', 'authenticated'] as const) {
      await useSession(db, role, { userId: user })
      await expect(db.query('select public.worker_claim_generation($1, $2)', [job, randomUUID()])).rejects.toThrow(/permission denied/)
      await expect(db.query('select * from public.worker_reap_stale_generations(10, 50)')).rejects.toThrow(/permission denied/)
      await expect(db.query('select public.worker_get_image_provider_api_key($1, $2)', [randomUUID(), 'https://a.example/v1'])).rejects.toThrow(/permission denied/)
    }
  })
})

// ---------------------------------------------------------------------------
// RLS 与表权限
// ---------------------------------------------------------------------------

describe('RLS 与表权限', () => {
  it('用户只能登记自己 references 目录下的参考图', async () => {
    const user = await createUser()
    const other = await createUser()
    await useSession(db, 'authenticated', { userId: user })
    await db.query(
      `insert into public.assets (user_id, kind, name, storage_path, mime_type) values ($1, 'reference', 'a.png', $2, 'image/png')`,
      [user, `${user}/references/${randomUUID()}.png`],
    )
    await expect(db.query(
      `insert into public.assets (user_id, kind, name, storage_path, mime_type) values ($1, 'reference', 'b.png', $2, 'image/png')`,
      [user, `${other}/references/${randomUUID()}.png`],
    )).rejects.toThrow(/row-level security/)
  })

  it('用户不能直接写入生成结果素材', async () => {
    const user = await createUser()
    const job = await createJob(user, 10)
    await useSession(db, 'authenticated', { userId: user })
    await expect(db.query(
      `insert into public.assets (user_id, job_id, kind, name, storage_path, mime_type, cell_index) values ($1, $2, 'sticker', 'x', $3, 'image/png', 0)`,
      [user, job, `${user}/jobs/${job}/01.png`],
    )).rejects.toThrow(/row-level security|permission denied/)
    await expect(db.query(
      `update public.assets set name = 'hacked' where user_id = $1`, [user],
    )).rejects.toThrow(/permission denied/)
  })

  it('用户不能直接修改任务、账本或余额', async () => {
    const user = await createUser()
    await setBalance(user, 100)
    const job = await createJob(user, 10)
    await useSession(db, 'authenticated', { userId: user })
    await expect(db.query("update public.generation_jobs set status = 'completed' where id = $1", [job])).rejects.toThrow(/permission denied/)
    await expect(db.query("insert into public.wallet_transactions (user_id, amount, note) values ($1, 999, 'x')", [user])).rejects.toThrow(/permission denied/)
    await expect(db.query('update public.wallet_balances set balance = 999999 where user_id = $1', [user])).rejects.toThrow(/permission denied/)
    expect(await balanceOf(user)).toBe(100)
  })

  it('用户只能读取自己的任务、素材和账本', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    await setBalance(owner, 50)
    const job = await createJob(owner, 10)
    await addStickers(owner, job, [0])
    await useSession(db, 'authenticated', { userId: stranger })
    expect((await db.query('select id from public.generation_jobs where id = $1', [job])).rows).toHaveLength(0)
    expect((await db.query('select id from public.assets where job_id = $1', [job])).rows).toHaveLength(0)
    expect((await db.query('select id from public.wallet_transactions where user_id = $1', [owner])).rows).toHaveLength(0)
    await useSession(db, 'authenticated', { userId: owner })
    expect((await db.query('select id from public.assets where job_id = $1', [job])).rows).toHaveLength(1)
  })

  it('匿名用户没有任何业务表的权限', async () => {
    await useSession(db, 'anon')
    await expect(db.query('select value from public.admin_settings')).rejects.toThrow(/permission denied/)
    await expect(db.query('select id from public.generation_jobs')).rejects.toThrow(/permission denied/)
    await expect(db.query('select id from public.assets')).rejects.toThrow(/permission denied/)
  })
})

// ---------------------------------------------------------------------------
// 供应商密钥与 Base URL 绑定
// ---------------------------------------------------------------------------

const PROVIDER_ID = randomUUID()
const MODEL_ID = randomUUID()

/** Write the admin-facing provider JSON. `secretConfigured` mirrors what the admin UI keeps when only the URL is edited. */
async function seedProvider(baseUrl: string, options: { enabled?: boolean; secretConfigured?: boolean } = {}) {
  await owner()
  const { enabled = true, secretConfigured = false } = options
  const providers = [{
    id: PROVIDER_ID,
    name: '测试供应商',
    protocol: 'responses',
    baseUrl,
    secretConfigured,
    models: [{ id: MODEL_ID, name: 'gpt-image-test', enabled, priceCoins: 25 }],
  }]
  await db.query("update public.admin_settings set value = $1::jsonb where setting_key = 'model'", [JSON.stringify({ providers })])
}

async function saveKey(apiKey: string, adminId: string) {
  await useSession(db, 'authenticated', { userId: adminId, admin: true })
  await db.query('select public.admin_set_image_provider_api_key($1, $2)', [PROVIDER_ID, apiKey])
}

async function storedKey(baseUrl: string): Promise<string | null> {
  await service()
  const { rows } = await db.query<{ worker_get_image_provider_api_key: string }>('select public.worker_get_image_provider_api_key($1, $2) as worker_get_image_provider_api_key', [PROVIDER_ID, baseUrl])
  return rows[0]?.worker_get_image_provider_api_key ?? null
}

async function publicModelIds(): Promise<string[]> {
  await useSession(db, 'anon')
  const { rows } = await db.query<{ id: string }>('select id from public.public_enabled_image_models()')
  return rows.map((row) => row.id)
}

describe('供应商密钥绑定', () => {
  it('密钥只发往保存时绑定的 Base URL（忽略末尾斜杠）', async () => {
    const admin = await createUser()
    await seedProvider('https://api.example.com/v1/')
    await saveKey('sk-test-0123456789', admin)
    expect(await storedKey('https://api.example.com/v1')).toBe('sk-test-0123456789')
    expect(await storedKey('https://api.example.com/v1/')).toBe('sk-test-0123456789')
    await service()
    await expect(db.query('select public.worker_get_image_provider_api_key($1, $2)', [PROVIDER_ID, 'https://evil.example.net/v1'])).rejects.toThrow(/endpoint changed/)
  })

  it('非管理员不能保存供应商密钥', async () => {
    const user = await createUser()
    await useSession(db, 'authenticated', { userId: user })
    await expect(db.query('select public.admin_set_image_provider_api_key($1, $2)', [PROVIDER_ID, 'sk-test-0123456789'])).rejects.toThrow(/admin access required/)
  })

  it('修改 Base URL 后模型从前台隐藏，重新保存密钥后恢复', async () => {
    const admin = await createUser()
    await seedProvider('https://api.example.com/v1')
    await saveKey('sk-test-0123456789', admin)
    expect(await publicModelIds()).toContain(MODEL_ID)

    // 模拟管理员只改了地址、没有重新保存密钥：旧密钥不能再被发送到新地址。
    await seedProvider('https://other.example.com/v1', { secretConfigured: true })
    expect(await publicModelIds()).not.toContain(MODEL_ID)
    await service()
    await expect(db.query('select public.worker_get_image_provider_api_key($1, $2)', [PROVIDER_ID, 'https://other.example.com/v1'])).rejects.toThrow(/endpoint changed/)

    await saveKey('sk-test-abcdefgh', admin)
    expect(await publicModelIds()).toContain(MODEL_ID)
    expect(await storedKey('https://other.example.com/v1')).toBe('sk-test-abcdefgh')
  })

  it('升级已保存密钥的旧库时补上 Base URL 绑定', async () => {
    // 独立数据库：先停在第 4 个迁移，写入“旧版”供应商与密钥，再执行第 5 个迁移。
    const legacy = await createTestDatabase({ throughFile: '20261008103000_provider_model_settings.sql' })
    try {
      const providerId = randomUUID()
      await legacy.exec(`
        insert into vault.secrets (name, description, secret) values (
          'jiwang-image-provider-${providerId}', 'legacy', 'sk-legacy-0123456789'
        );
      `)
      await legacy.query(
        "update public.admin_settings set value = $1::jsonb where setting_key = 'model'",
        [JSON.stringify({ providers: [{ id: providerId, name: '旧供应商', protocol: 'responses', baseUrl: 'https://legacy.example.com/v1', secretConfigured: true, models: [] }] })],
      )
      await applyMigrations(legacy, ['20261008120000_generation_recovery.sql'])
      await useSession(legacy, 'service_role')
      const { rows } = await legacy.query<{ worker_get_image_provider_api_key: string }>(
        'select public.worker_get_image_provider_api_key($1, $2) as worker_get_image_provider_api_key',
        [providerId, 'https://legacy.example.com/v1'],
      )
      expect(rows[0]?.worker_get_image_provider_api_key).toBe('sk-legacy-0123456789')
    } finally {
      await legacy.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 前台功能开关与后台任务列表
// ---------------------------------------------------------------------------

describe('前台功能开关与后台任务列表', () => {
  it('功能开关默认开启；维护模式只在后台设置开启后生效', async () => {
    await useSession(db, 'anon')
    const defaults = await db.query<{ public_site_features: Record<string, boolean> }>('select public.public_site_features()')
    expect(defaults.rows[0]?.public_site_features).toEqual({ signup: true, customThemes: true, maintenance: false })

    await owner()
    await db.query(
      `update public.admin_settings set value = '{"signup": false, "customThemes": false, "maintenance": true}'::jsonb where setting_key = 'features'`,
    )
    const changed = await db.query<{ public_site_features: Record<string, boolean> }>('select public.public_site_features()')
    expect(changed.rows[0]?.public_site_features).toEqual({ signup: false, customThemes: false, maintenance: true })
    await owner()
    await db.query(`update public.admin_settings set value = '{"signup": true, "customThemes": true, "communitySubmissions": false, "maintenance": false}'::jsonb where setting_key = 'features'`)
  })

  it('管理员列表返回真实交付数与尝试号', async () => {
    const admin = await createUser()
    const user = await createUser()
    await setBalance(user, 100)
    const job = await createJob(user, 60)
    const token = await claim(job)
    await reserve(job, token)
    await addStickers(user, job, Array.from({ length: 5 }, (_, index) => index))
    await complete(job, token)

    await useSession(db, 'authenticated', { userId: admin, admin: true })
    const { rows } = await db.query<{ job_id: string; status: string; completed_count: number; attempt: number }>(
      'select job_id, status, completed_count, attempt from public.admin_list_jobs_with_model(200)',
    )
    expect(rows.find((row) => row.job_id === job)).toMatchObject({ status: 'partial', completed_count: 5, attempt: 1 })
  })
})
