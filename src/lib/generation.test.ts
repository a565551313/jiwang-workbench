import { beforeEach, describe, expect, it, vi } from 'vitest'

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))

vi.mock('./supabase', () => ({
  supabase: { rpc },
  supabaseConfigured: true,
}))

import { explainGenerationError, explainPreparationError, loadEnabledImageModels } from './generation'

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
