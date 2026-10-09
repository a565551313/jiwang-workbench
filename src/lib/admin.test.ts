import { describe, expect, it } from 'vitest'
import { baseUrlChanged, getProviderSaveIssues, type AdminImageProvider } from './admin'

function provider(overrides: Partial<AdminImageProvider> = {}): AdminImageProvider {
  return {
    id: 'provider-1',
    name: '测试供应商',
    protocol: 'responses',
    baseUrl: 'https://api.example.com/v1',
    secretConfigured: true,
    models: [{ id: 'model-1', name: 'image-model', enabled: true, priceCoins: 25 }],
    ...overrides,
  }
}

describe('供应商模型保存校验', () => {
  it('有效启用模型可保存', () => {
    expect(getProviderSaveIssues(provider(), '')).toEqual([])
  })

  it('价格为 0 时明确指出模型必须设置 1–100000 的整数价格', () => {
    const issues = getProviderSaveIssues(provider({
      models: [{ id: 'model-1', name: 'gpt-image-2.5', enabled: true, priceCoins: 0 }],
    }), '')
    expect(issues).toContain('模型「gpt-image-2.5」已勾选，但汪币价格无效；请设置 1–100000 的整数价格后再保存。')
  })

  it('停用模型允许保留零价格', () => {
    expect(getProviderSaveIssues(provider({
      models: [{ id: 'model-1', name: 'image-model', enabled: false, priceCoins: 0 }],
    }), '')).toEqual([])
  })

  it('启用模型时要求已保存或正在填写的 API Key', () => {
    const withoutSecret = provider({ secretConfigured: false })
    expect(getProviderSaveIssues(withoutSecret, '')).toContain('已勾选模型，但供应商 API Key 尚未保存；请先填写 API Key。')
    expect(getProviderSaveIssues(withoutSecret, '12345678')).toEqual([])
  })

  it('拒绝重复模型 ID 和非 HTTPS 地址', () => {
    const invalid = provider({
      baseUrl: 'http://api.example.com/v1',
      models: [
        { id: 'model-1', name: 'same-model', enabled: false, priceCoins: 0 },
        { id: 'model-2', name: ' same-model ', enabled: false, priceCoins: 0 },
      ],
    })
    expect(getProviderSaveIssues(invalid, '')).toContain('请填写有效的 HTTPS Base URL。')
    expect(getProviderSaveIssues(invalid, '')).toContain('同一供应商下的模型 ID 不能重复。')
  })

  it('修改已保存密钥的供应商 Base URL 时必须重新输入 API Key', () => {
    const changed = provider({ baseUrl: 'https://evil.example.net/v1' })
    const issues = getProviderSaveIssues(changed, '', 'https://api.example.com/v1')
    expect(issues.join('\n')).toContain('修改 Base URL 后必须重新输入 API Key')
    expect(getProviderSaveIssues(changed, '12345678', 'https://api.example.com/v1')).toEqual([])
  })

  it('只改末尾斜杠不算修改地址；未保存密钥的新供应商也无需检查', () => {
    expect(baseUrlChanged('https://api.example.com/v1/', 'https://api.example.com/v1')).toBe(false)
    expect(getProviderSaveIssues(provider({ baseUrl: 'https://api.example.com/v1/' }), '', 'https://api.example.com/v1')).toEqual([])
    expect(getProviderSaveIssues(provider({ secretConfigured: false, baseUrl: 'https://new.example.com/v1' }), '12345678', undefined)).toEqual([])
  })
})
