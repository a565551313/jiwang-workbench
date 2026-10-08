import { beforeEach, describe, expect, it, vi } from 'vitest'

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))

vi.mock('./supabase', () => ({
  supabase: { rpc },
  supabaseConfigured: true,
}))

import { loadEnabledImageModels } from './generation'

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
