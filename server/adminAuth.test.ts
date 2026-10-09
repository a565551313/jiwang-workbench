// 管理员会话有效期与签名校验的回归测试。
import type { IncomingMessage } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { currentSession, serializeSession, sessionSeconds } from './adminAuth'

const SECRET = 'x'.repeat(48)
const START = new Date('2026-10-08T02:00:00Z').getTime()
const HOUR_MS = 60 * 60 * 1000

function requestWithSession(token: string): IncomingMessage {
  return { headers: { cookie: `jiwang_admin_session=${token}` } } as unknown as IncomingMessage
}

describe('管理员会话有效期', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(START)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('会话有效期为 2 小时', () => {
    expect(sessionSeconds).toBe(2 * 60 * 60)
  })

  it('2 小时之内的会话仍然有效', () => {
    const token = serializeSession('admin', SECRET)
    vi.setSystemTime(START + 2 * HOUR_MS - 1000)
    expect(currentSession(requestWithSession(token), SECRET)?.username).toBe('admin')
  })

  it('超过 2 小时后会话失效，需要重新登录', () => {
    const token = serializeSession('admin', SECRET)
    vi.setSystemTime(START + 2 * HOUR_MS + 1000)
    expect(currentSession(requestWithSession(token), SECRET)).toBeNull()
  })

  it('篡改签名或使用其他密钥签发的会话会被拒绝', () => {
    const token = serializeSession('admin', SECRET)
    const [payload, signature] = token.split('.')
    const tampered = `${payload}.${signature!.slice(0, -2)}AA`
    expect(currentSession(requestWithSession(tampered), SECRET)).toBeNull()
    expect(currentSession(requestWithSession(token), 'y'.repeat(48))).toBeNull()
  })
})
