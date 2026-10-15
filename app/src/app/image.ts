/**
 * 图片瘦身（§6.9 / FR-1417）。
 *
 * 上传前在本地压缩：长边 ≤ 1024px、转 JPEG、质量 0.7。重新绘制会顺带丢掉 EXIF
 * （其中的 GPS 定位不该发给模型）。压缩结果只存在于内存，请求结束即释放，不落库。
 */

export const MAX_IMAGE_EDGE = 1024
export const IMAGE_JPEG_QUALITY = 0.7

export function readImageAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

export function loadImageElement(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片解析失败'))
    image.src = dataUrl
  })
}

export interface CompressImageOptions {
  maxEdge?: number
  quality?: number
}

export async function compressImageFile(file: File, options: CompressImageOptions = {}): Promise<string> {
  const maxEdge = options.maxEdge ?? MAX_IMAGE_EDGE
  const quality = options.quality ?? IMAGE_JPEG_QUALITY
  const dataUrl = await readImageAsDataUrl(file)
  const image = await loadImageElement(dataUrl)

  const longest = Math.max(image.width, image.height)
  const scale = longest > 0 ? Math.min(1, maxEdge / longest) : 1
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return dataUrl
  context.drawImage(image, 0, 0, width, height)
  return canvas.toDataURL('image/jpeg', quality)
}
