import { describe, expect, it } from 'vitest'
import {
  base64FromBytes,
  bytesFromBase64,
  chargeForDelivered,
  isFatalUpstreamStatus,
  isNonPublicAddress,
  isUuid,
  normalizeBaseUrl,
  progressForDelivered,
  promptForCell,
  readLimitedBytes,
  safeEndpoint,
  safeUpstreamDetail,
  stickerStoragePath,
  summarizeCellFailures,
  UpstreamHttpError,
  upstreamErrorMessage,
  validateCells,
  validateReferencePath,
  type JobOptions,
} from '../functions/jiwang-generate/shared'

/** Host as the Edge runtime sees it: WHATWG URL canonicalisation applies first. */
function hostOf(url: string): string {
  return new URL(url).hostname
}

describe('内网地址拦截（SSRF）', () => {
  it.each([
    'localhost',
    'api.localhost',
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    'metadata.google.internal',
    'printer.local',
    'billing.internal',
    'intranet', // 单标签主机名只能解析到内网
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
  ])('拒绝 %s', (host) => {
    expect(isNonPublicAddress(host)).toBe(true)
  })

  it.each([
    'https://[::ffff:127.0.0.1]/v1', // 映射地址：URL 会规范化为 ::ffff:7f00:1
    'https://[::ffff:169.254.169.254]/v1',
    'https://[::ffff:10.0.0.5]/v1',
    'https://[64:ff9b::7f00:1]/v1', // NAT64 嵌入的 127.0.0.1
    'https://[::127.0.0.1]/v1', // 已弃用的兼容地址
  ])('拒绝 IPv6 内嵌的内网 IPv4：%s', (url) => {
    expect(isNonPublicAddress(hostOf(url))).toBe(true)
  })

  it.each(['8.8.8.8', '1.1.1.1', 'api.openai.com', 'api.example.com', '[2001:4860:4860::8888]', 'https://[::ffff:8.8.8.8]/v1'])('允许公网地址 %s', (value) => {
    const host = value.startsWith('https://') ? hostOf(value) : value
    expect(isNonPublicAddress(host)).toBe(false)
  })

  it('把 IPv4 的各种写法规范化后再判断', () => {
    // 2130706433 是 127.0.0.1 的十进制写法；URL 解析会把它规范化为 127.0.0.1。
    expect(isNonPublicAddress(hostOf('https://2130706433/v1'))).toBe(true)
    expect(isNonPublicAddress(hostOf('https://0x7f000001/v1'))).toBe(true)
  })
})

describe('上游 Base URL 校验', () => {
  it('去掉末尾斜杠并保留版本路径', () => {
    expect(safeEndpoint('https://api.example.com/v1/')).toBe('https://api.example.com/v1')
    expect(safeEndpoint('  https://api.example.com/v1  ')).toBe('https://api.example.com/v1')
  })

  it('留空时使用 OpenAI 默认地址', () => {
    expect(safeEndpoint('   ')).toBe('https://api.openai.com/v1')
  })

  it.each([
    ['http://api.example.com/v1', '必须是干净的 HTTPS 地址'],
    ['https://user:pass@api.example.com/v1', '必须是干净的 HTTPS 地址'],
    ['https://api.example.com/v1?key=1', '必须是干净的 HTTPS 地址'],
    ['https://api.example.com/v1#x', '必须是干净的 HTTPS 地址'],
    ['https://api.example.com:8443/v1', '默认的 HTTPS 端口'],
    ['https://localhost/v1', '内网主机'],
    ['https://[::ffff:127.0.0.1]/v1', '内网主机'],
    ['https://169.254.169.254/latest', '内网主机'],
    ['https://2130706433/v1', '内网主机'],
    ['not a url', '格式无效'],
  ])('拒绝 %s', (value, message) => {
    expect(() => safeEndpoint(value)).toThrow(message)
  })

  it('规范化函数与数据库中的绑定规则一致', () => {
    expect(normalizeBaseUrl(' https://api.example.com/v1/// ')).toBe('https://api.example.com/v1')
  })
})

describe('任务脚本与参考图校验', () => {
  const cell = (n: number) => ({ caption: `短句${n}`, visual: `画面${n}` })

  it('只接受恰好 16 格且每格都有文字', () => {
    const valid = Array.from({ length: 16 }, (_, index) => cell(index))
    expect(validateCells(valid)).toHaveLength(16)
    expect(validateCells(valid.slice(0, 15))).toBeNull()
    expect(validateCells([...valid.slice(0, 15), { caption: '  ', visual: '画面' }])).toBeNull()
    expect(validateCells('not-an-array')).toBeNull()
  })

  it('会裁剪过长的文字并去掉首尾空白', () => {
    const valid = Array.from({ length: 16 }, (_, index) => ({ caption: `  ${'字'.repeat(100)}  `, visual: `画面${index}` }))
    const cells = validateCells(valid)!
    expect(cells[0]!.caption).toHaveLength(80)
    expect(cells[0]!.caption.startsWith('字')).toBe(true)
  })

  it('参考图只能位于当前用户的 references 目录', () => {
    const user = '11111111-1111-4111-8111-111111111111'
    expect(validateReferencePath(`${user}/references/a.png`, user)).toBe(true)
    expect(validateReferencePath(`${user}/jobs/x/01.png`, user)).toBe(false)
    expect(validateReferencePath(`${user}/references/../../x.png`, user)).toBe(false)
    expect(validateReferencePath(`22222222-2222-4222-8222-222222222222/references/a.png`, user)).toBe(false)
    expect(validateReferencePath(`${user}/references/${'a'.repeat(600)}.png`, user)).toBe(false)
  })

  it('UUID 校验只接受标准格式', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true)
    expect(isUuid('11111111111141118111111111111111')).toBe(false)
    expect(isUuid('../../etc/passwd')).toBe(false)
  })
})

describe('单格提示词', () => {
  const options: JobOptions = { cellCount: 16, cells: [], originalStyle: true, noText: false, whiteBorder: true }
  const cell = { caption: '早上好', visual: '伸懒腰醒来' }

  it('填入主题、文字和画面，并标注格序', () => {
    const prompt = promptForCell('主题：{{topic}}；文字：{{caption}}；画面：{{visual}}', '打工人', cell, 2, options)
    expect(prompt.startsWith('主题：打工人；文字：早上好；画面：伸懒腰醒来')).toBe(true)
    expect(prompt).toContain('cell 3 of 16')
    expect(prompt).toContain('“早上好”')
  })

  it('无文字模式禁止渲染文字', () => {
    const prompt = promptForCell('{{caption}}', '主题', cell, 0, { ...options, noText: true })
    expect(prompt).toContain('Do not render any letters')
    expect(prompt).not.toContain('“早上好”')
  })
})

describe('Base64 与存储路径', () => {
  it('往返编码保持字节不变', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
    expect(Array.from(bytesFromBase64(base64FromBytes(bytes)))).toEqual(Array.from(bytes))
  })

  it('非法 Base64 会抛出异常', () => {
    expect(() => bytesFromBase64('***not base64***')).toThrow()
  })

  it('格式化的对象路径包含两位格序和正确扩展名', () => {
    expect(stickerStoragePath('u1', 'j1', 2, 'image/jpeg')).toBe('u1/jobs/j1/03.jpg')
    expect(stickerStoragePath('u1', 'j1', 15, 'image/webp')).toBe('u1/jobs/j1/16.webp')
    expect(stickerStoragePath('u1', 'j1', 0, 'image/png')).toBe('u1/jobs/j1/01.png')
  })
})

describe('有上限的响应读取', () => {
  it('在上限内读取完整内容', async () => {
    const bytes = await readLimitedBytes(new Response(new Uint8Array([1, 2, 3, 4])), 10)
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4])
  })

  it('声明的 Content-Length 超限时直接拒绝', async () => {
    const response = new Response(new Uint8Array(20), { headers: { 'content-length': '20' } })
    await expect(readLimitedBytes(response, 10)).rejects.toThrow('限制')
  })

  it('流式超限时取消上游读取，而不是整体缓冲', async () => {
    let cancelled = false
    const chunk = new Uint8Array(6)
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk)
      },
      cancel() {
        cancelled = true
      },
    })
    await expect(readLimitedBytes(new Response(stream), 10)).rejects.toThrow('限制')
    expect(cancelled).toBe(true)
  })

  it('没有响应体时返回空数组', async () => {
    expect((await readLimitedBytes(new Response(null), 10)).byteLength).toBe(0)
  })
})

describe('上游错误与脱敏', () => {
  it('对常见 HTTP 状态给出可操作的中文说明', () => {
    expect(upstreamErrorMessage('Responses API', 401, '')).toContain('API Key 无效')
    expect(upstreamErrorMessage('Responses API', 429, '')).toContain('限流')
    expect(upstreamErrorMessage('Chat Completions', 503, '')).toContain('服务暂时异常')
    expect(upstreamErrorMessage('Responses API', 401, '')).toContain('建议：')
  })

  it('错误详情中的密钥与 Bearer 凭据会被隐藏', () => {
    const body = JSON.stringify({ error: { message: 'bad key sk-abcdefghijklmnop and Bearer abc.def.ghi, also my-secret-value' } })
    const detail = safeUpstreamDetail(body, 'my-secret-value')
    expect(detail).not.toContain('sk-abcdefghijklmnop')
    expect(detail).not.toContain('my-secret-value')
    expect(detail).not.toContain('abc.def.ghi')
    expect(detail).toContain('[凭据已隐藏]')
  })

  it('HTML 错误页不会原样返回', () => {
    expect(safeUpstreamDetail('<html><body>Bad gateway</body></html>', '')).toBe('')
  })

  it('UpstreamHttpError 携带状态码，并且只有请求类错误被视为致命', () => {
    const error = new UpstreamHttpError('x', 401)
    expect(error.status).toBe(401)
    expect(error instanceof Error).toBe(true)
    expect(isFatalUpstreamStatus(401)).toBe(true)
    expect(isFatalUpstreamStatus(403)).toBe(true)
    expect(isFatalUpstreamStatus(429)).toBe(false)
    expect(isFatalUpstreamStatus(503)).toBe(false)
  })

  it('多张失败时只展开第一条完整说明，并提示其余数量', () => {
    expect(summarizeCellFailures([])).toBe('')
    expect(summarizeCellFailures([{ cell: 3, message: '第一条', fatal: false }])).toBe('第一条')
    expect(summarizeCellFailures([
      { cell: 3, message: '第一条', fatal: false },
      { cell: 9, message: '第二条', fatal: false },
    ])).toBe('第一条\n另有 1 张也未能生成。')
  })
})

describe('进度与计费换算（需与 SQL 结算一致）', () => {
  it('进度从 5% 线性增长到 95%，并且不会越界', () => {
    expect(progressForDelivered(0)).toBe(5)
    expect(progressForDelivered(8)).toBe(50)
    expect(progressForDelivered(16)).toBe(95)
    expect(progressForDelivered(-3)).toBe(5)
    expect(progressForDelivered(99)).toBe(95)
  })

  it('应收 = ceil(单价 × 交付张数 ÷ 16)', () => {
    expect(chargeForDelivered(60, 16)).toBe(60) // 满套等于单价
    expect(chargeForDelivered(60, 13)).toBe(49)
    expect(chargeForDelivered(60, 8)).toBe(30)
    expect(chargeForDelivered(60, 1)).toBe(4) // 向上取整
    expect(chargeForDelivered(60, 0)).toBe(0)
    expect(chargeForDelivered(1, 1)).toBe(1)
  })
})
