export async function makeZip(images: string[], captions: string[]) {
  const JSZip = (await import('jszip')).default
  const zip = new JSZip()
  await Promise.all(images.map(async (url, index) => {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`第 ${index + 1} 张图片读取失败`)
    const extension = response.headers.get('content-type')?.split('/')[1]?.split(';')[0] || 'png'
    const safeExtension = extension === 'jpeg' ? 'jpg' : extension.replace(/[^a-z0-9]/gi, '') || 'png'
    const filename = `${String(index + 1).padStart(2, '0')}-${(captions[index] || '表情').replace(/[\\/:*?"<>|]/g, '')}.${safeExtension}`
    zip.file(filename, await response.blob())
  }))
  return zip.generateAsync({ type: 'blob' })
}
