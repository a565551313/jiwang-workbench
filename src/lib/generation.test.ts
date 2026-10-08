import { beforeEach, describe, expect, it, vi } from 'vitest'

const { rpc, invoke } = vi.hoisted(() => ({ rpc: vi.fn(), invoke: vi.fn() }))

vi.mock('./supabase', () => ({
  supabase: { rpc, functions: { invoke } },
  supabaseConfigured: true,
}))

import {
  defaultPublicFeatures,
  explainGenerationError,
  explainPreparationError,
  GenerationHttpError,
  isNotStartedError,
  loadEnabledImageModels,
  loadPublicFeatures,
  retryGenerationJob,
} from './generation'

const modelRow = {
  id: '41223bf7-d355-42c4-800f-7b31ae33267b',
  provider: 'OpenAI 兼容接口',
  name: 'gpt-image-2',
  price_coins: 1,
}

describe('已启用图像模型列表', () => {
  beforeEach(() => rpc.mockReset())

  it('合并同时发出的请求，避免重复读取互相覆盖', async () => {
    let resolveRequest!: (value: { data: typeof modelRow[]; error: null }) => void
    rpc.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve }))

    const first = loadEnabledImageModels()
    const second = loadEnabledImageModels()
    expect(rpc).toHaveBeenCalledTimes(1)

    resolveRequest({ data: [modelRow], error: null })
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toEqual(secondResult)
    expect(firstResult).toEqual([{
      id: modelRow.id,
      provider: modelRow.provider,
      name: modelRow.name,
      priceCoins: 1,
    }])
  })

  it('首次请求遇到暂时错误时自动重试并返回已配置模型', async () => {
    rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'temporary network error' } })
      .mockResolvedValueOnce({ data: [modelRow], error: null })

    await expect(loadEnabledImageModels()).resolves.toEqual([{
      id: modelRow.id,
      provider: modelRow.provider,
      name: modelRow.name,
      priceCoins: 1,
    }])
    expect(rpc).toHaveBeenCalledTimes(2)
  })
})

describe('生成失败提示', () => {
  it('把 Responses API 403 展开为权限、协议和模型配置排查建议', () => {
    const message = explainGenerationError('Responses API 请求失败（403）；请检查协议及模型 ID')
    expect(message).toContain('HTTP 403')
    expect(message).toContain('API Key 无权调用该模型')
    expect(message).toContain('Base URL')
    expect(message).toContain('不要连续重复提交')
  })

  it('对限流、余额不足和超时分别给出下一步', () => {
    expect(explainGenerationError('上游模型接口请求失败（429）')).toContain('速率限制')
    expect(explainGenerationError('Responses API 上游接口返回 HTTP 402，上游账户额度或付款状态不足。\n建议：请管理员检查供应商账户余额、配额和计费状态。')).toContain('上游账户额度或付款状态不足')
    expect(explainGenerationError('汪币余额不足')).toContain('模型调用未开始')
    expect(explainGenerationError('请求超时')).toContain('不要立即重复提交')
  })

  it('保留服务端已给出的建议，未知错误也提醒核对任务与退款', () => {
    const detailed = '请求失败\n建议：检查供应商配置'
    expect(explainGenerationError(detailed)).toBe(detailed)
    expect(explainGenerationError('异常')).toContain('任务状态和退款结果')
  })

  it('区分余额读取、存储权限和云端资源缺失', () => {
    expect(explainPreparationError('汪币余额读取', 'network request failed')).toContain('这一步尚未开始模型调用')
    expect(explainPreparationError('参考图云端保存', 'new row violates row-level security')).toContain('RLS 策略')
    expect(explainPreparationError('参考图云端保存', 'Bucket not found')).toContain('jiwang-private')
  })
})

describe('站点功能开关', () => {
  beforeEach(() => rpc.mockReset())

  it('读取后台开关并映射为前台字段', async () => {
    rpc.mockResolvedValueOnce({ data: { signup: false, customThemes: true, maintenance: true }, error: null })
    await expect(loadPublicFeatures()).resolves.toEqual({ signup: false, customThemes: true, maintenance: true })
    expect(rpc).toHaveBeenCalledWith('public_site_features')
  })

  it('读取失败时保持默认开放，维护状态以服务端拦截为准', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } })
    await expect(loadPublicFeatures()).resolves.toEqual(defaultPublicFeatures)
  })
})

describe('生成服务的错误码', () => {
  beforeEach(() => invoke.mockReset())

  function failedInvoke(status: number, payload: Record<string, unknown>) {
    invoke.mockResolvedValue({
      data: null,
      error: Object.assign(new Error('Edge Function returned a non-2xx status code'), {
        context: new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } }),
      }),
    })
  }

  it('开始前被拒绝的请求保留错误码，界面可以判断为「未开始、未扣费」', async () => {
    failedInvoke(429, { error: '今天已达上限，请明天再试。', code: 'quota_daily' })
    const error = await retryGenerationJob('6f1c7b2e-3d4a-4b5c-8d9e-0f1a2b3c4d5e').catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(GenerationHttpError)
    expect(error).toMatchObject({ status: 429, code: 'quota_daily', message: '今天已达上限，请明天再试。' })
    expect(isNotStartedError(error)).toBe(true)
  })

  it('参考图过期与维护同样属于「未开始」', async () => {
    failedInvoke(409, { error: '参考图已过期', code: 'reference_missing' })
    const missing = await retryGenerationJob('6f1c7b2e-3d4a-4b5c-8d9e-0f1a2b3c4d5e').catch((cause: unknown) => cause)
    expect(isNotStartedError(missing)).toBe(true)

    failedInvoke(503, { error: '维护中', code: 'maintenance', maintenance: true })
    const maintenance = await retryGenerationJob('6f1c7b2e-3d4a-4b5c-8d9e-0f1a2b3c4d5e').catch((cause: unknown) => cause)
    expect(isNotStartedError(maintenance)).toBe(true)
  })

  it('普通错误没有错误码，不会被当作未开始', async () => {
    failedInvoke(502, { error: '上游模型暂时不可用' })
    const error = await retryGenerationJob('6f1c7b2e-3d4a-4b5c-8d9e-0f1a2b3c4d5e').catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(GenerationHttpError)
    expect(error).toMatchObject({ status: 502, code: '' })
    expect(isNotStartedError(error)).toBe(false)
  })
})
