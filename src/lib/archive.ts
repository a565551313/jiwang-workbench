export interface ZipEntry {
  url: string
  /** File name without extension; the extension comes from the image's content type. */
  filename: string
}

const DOWNLOAD_CONCURRENCY = 4

function safeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '').trim() || '表情'
}

/** Download the given images (bounded concurrency) and package them into one ZIP blob. */
export async function makeZip(entries: ZipEntry[]): Promise<Blob> {
  const JSZip = (await import('jszip')).default
  const zip = new JSZip()
  let next = 0
  const worker = async () => {
    while (next < entries.length) {
      const entry = entries[next]!
      next += 1
      const response = await fetch(entry.url)
      if (!response.ok) throw new Error(`${entry.filename} 图片读取失败（HTTP ${response.status}），链接可能已过期，请刷新页面后重试`)
      const extension = response.headers.get('content-type')?.split('/')[1]?.split(';')[0] || 'png'
      const safeExtension = extension === 'jpeg' ? 'jpg' : extension.replace(/[^a-z0-9]/gi, '') || 'png'
      zip.file(`${safeFilename(entry.filename)}.${safeExtension}`, await response.blob())
    }
  }
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, entries.length) }, () => worker()))
  return zip.generateAsync({ type: 'blob' })
}
