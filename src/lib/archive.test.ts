import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeZip } from './archive'

afterEach(() => {
  vi.unstubAllGlobals()
})

function imageResponse(bytes: number[], type = 'image/png') {
  return new Response(new Uint8Array(bytes), { headers: { 'content-type': type } })
}

describe('素材 ZIP 打包', () => {
  it('按传入的文件名保存，并去掉非法字符', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => imageResponse([1, 2, 3])))
    const blob = await makeZip([
      { url: 'https://cdn.test/a', filename: '01-早安' },
      { url: 'https://cdn.test/b', filename: '02-晚安/..' },
    ])
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    expect(Object.keys(zip.files).sort()).toEqual(['01-早安.png', '02-晚安...png'])
  })

  it('图片链接失效时给出明确提示，而不是静默缺图', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 403 })))
    await expect(makeZip([{ url: 'https://cdn.test/x', filename: '01-x' }])).rejects.toThrow('链接可能已过期')
  })

  it('同时下载的图片数量有上限，避免一次打开过多连接', async () => {
    let inFlight = 0
    let peak = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return imageResponse([9])
    }))
    const entries = Array.from({ length: 12 }, (_, index) => ({ url: `https://cdn.test/${index}`, filename: `${index + 1}` }))
    await makeZip(entries)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(4)
  })
})
