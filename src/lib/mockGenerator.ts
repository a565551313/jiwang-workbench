import type { DraftCell, GenerationOptions } from '../types'

const colors = ['#f8e6d8', '#e1eee1', '#ece7fb', '#f7e5ec', '#e1edf5', '#f9f1d5', '#e9eddd', '#f5e7db']
const accents = ['✦', '♡', '✿', '☁', '✧', '•', '♡', '✦']

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('无法读取这张图片'))
    image.src = src
  })
}

export async function generateMockCells(
  referenceUrl: string,
  cells: DraftCell[],
  options: GenerationOptions,
): Promise<string[]> {
  const reference = await loadImage(referenceUrl)
  return Promise.all(cells.slice(0, 16).map((cell, index) => {
    const size = 384
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('浏览器无法创建画布')

    ctx.fillStyle = colors[index % colors.length]
    roundedRect(ctx, 0, 0, size, size, 30)
    ctx.fill()
    ctx.save()
    ctx.globalAlpha = 0.3
    ctx.fillStyle = '#fff'
    ctx.beginPath()
    ctx.arc(315, 66, 54, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()

    const imageSize = options.originalStyle ? 202 : 184
    const imageY = 34 + (index % 3 === 1 ? 8 : 0)
    ctx.save()
    ctx.beginPath()
    ctx.arc(size / 2, imageY + imageSize / 2, imageSize / 2 + (options.whiteBorder ? 15 : 7), 0, Math.PI * 2)
    ctx.fillStyle = '#fff'
    ctx.fill()
    ctx.beginPath()
    ctx.arc(size / 2, imageY + imageSize / 2, imageSize / 2, 0, Math.PI * 2)
    ctx.clip()
    const scale = Math.max(imageSize / reference.width, imageSize / reference.height)
    const dw = reference.width * scale
    const dh = reference.height * scale
    ctx.drawImage(reference, size / 2 - dw / 2, imageY + imageSize / 2 - dh / 2, dw, dh)
    ctx.restore()

    ctx.font = 'bold 38px "Noto Sans SC", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#536957'
    ctx.fillText(accents[index % accents.length], 312, 85)

    if (!options.noText) {
      const label = cell.caption.trim().slice(0, 9) || `第${index + 1}格`
      ctx.font = '700 28px "Noto Sans SC", sans-serif'
      const labelWidth = Math.min(size - 36, Math.max(130, ctx.measureText(label).width + 42))
      const labelX = (size - labelWidth) / 2
      const labelY = 278
      ctx.save()
      ctx.shadowColor = 'rgba(43, 54, 45, .13)'
      ctx.shadowBlur = 12
      ctx.shadowOffsetY = 5
      roundedRect(ctx, labelX, labelY, labelWidth, 58, 22)
      ctx.fillStyle = options.whiteBorder ? '#fff' : 'rgba(255,255,255,.9)'
      ctx.fill()
      ctx.restore()
      ctx.fillStyle = '#28342b'
      ctx.fillText(label, size / 2, labelY + 30)
    }
    ctx.font = '500 15px "DM Sans", sans-serif'
    ctx.textAlign = 'right'
    ctx.fillStyle = 'rgba(44, 58, 46, .55)'
    ctx.fillText(String(index + 1).padStart(2, '0'), size - 18, size - 15)

    return canvas.toDataURL('image/png')
  }))
}

export async function makeZip(images: string[], captions: string[]) {
  const JSZip = (await import('jszip')).default
  const zip = new JSZip()
  images.forEach((url, index) => {
    zip.file(`${String(index + 1).padStart(2, '0')}-${(captions[index] || '表情').replace(/[\\/:*?"<>|]/g, '')}.png`, url.split(',')[1], { base64: true })
  })
  return zip.generateAsync({ type: 'blob' })
}
