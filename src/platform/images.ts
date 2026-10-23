import { PosError } from '../storage/errors'
import { IMAGE_LIMITS, checkImageDataUrl } from '../storage/images'

/**
 * Offline image intake for product photos and the QRIS picture.
 *
 * The picked file is checked BEFORE it is decoded (size, real format from its
 * magic bytes, pixel dimensions from its header), then decoded once, resized and
 * re-encoded as JPEG until it fits `IMAGE_LIMITS.outputMaxDataUrlLength`. Any
 * failure throws a `PosError` with a stable `IMAGE_*` code. The original file is
 * never stored as a fallback.
 */

export type SniffedImage = { mime: 'image/jpeg' | 'image/png' | 'image/webp'; width: number; height: number }

export type DecodedImage = { width: number; height: number; source: CanvasImageSource; close?: () => void }

/** Decoder/encoder seam. The browser implementation uses canvas; tests inject a fake. */
export type ImageCodec = {
  decode(file: Blob): Promise<DecodedImage>
  /** Returns a `data:` URL of the image scaled to width × height. */
  encode(image: DecodedImage, width: number, height: number, quality: number): Promise<string>
}

export type OptimizeImageOptions = { maxEdge?: number; quality?: number; maxDataUrlLength?: number }

/** Enough to reach the JPEG frame header past large EXIF/thumbnail segments. */
const HEAD_BYTES = 1024 * 1024

const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1]
const be32 = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]
const le16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8)
const le24 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n))

/** Reads the real format and pixel size from a file header. `null` = not a JPEG/PNG/WebP we can read. */
export function sniffImage(b: Uint8Array): SniffedImage | null {
  if (b.length >= 24 && be32(b, 0) === 0x89504e47 && be32(b, 4) === 0x0d0a1a0a && ascii(b, 12, 4) === 'IHDR') {
    return { mime: 'image/png', width: be32(b, 16), height: be32(b, 20) }
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null
      const marker = b[i + 1]
      if (marker === 0xff) { i += 1; continue }
      // SOF0–SOF15 except DHT (C4), JPG (C8), DAC (CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: 'image/jpeg', height: be16(b, i + 5), width: be16(b, i + 7) }
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
      if (marker === 0xd9 || marker === 0xda) return null
      i += 2 + be16(b, i + 2)
    }
    return null
  }
  if (b.length >= 16 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const chunk = ascii(b, 12, 4)
    if (chunk === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { mime: 'image/webp', width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff }
    if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
      return { mime: 'image/webp', width: 1 + (((b[22] & 0x3f) << 8) | b[21]), height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) }
    }
    if (chunk === 'VP8X' && b.length >= 30) return { mime: 'image/webp', width: 1 + le24(b, 24), height: 1 + le24(b, 27) }
  }
  return null
}

async function readHead(file: Blob, n: number) {
  const part = file.slice(0, n)
  if (typeof part.arrayBuffer === 'function') return new Uint8Array(await part.arrayBuffer())
  return new Uint8Array(await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.readAsArrayBuffer(part)
  }))
}

const fit = (width: number, height: number, maxEdge: number) => {
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

export const browserImageCodec: ImageCodec = {
  async decode(file) {
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(file)
      return { width: bitmap.width, height: bitmap.height, source: bitmap, close: () => bitmap.close() }
    }
    const url = URL.createObjectURL(file)
    try {
      const img = new Image()
      img.decoding = 'async'
      img.src = url
      await img.decode()
      return { width: img.naturalWidth, height: img.naturalHeight, source: img }
    } finally {
      URL.revokeObjectURL(url)
    }
  },
  async encode(image, width, height, quality) {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d tidak tersedia')
    // JPEG has no alpha: paint white first so transparent PNGs don't turn black.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(image.source, 0, 0, width, height)
    const url = canvas.toDataURL('image/jpeg', quality)
    canvas.width = canvas.height = 0
    return url
  },
}

const decodeFailed = () => new PosError('IMAGE_DECODE_FAILED', 'Gambar rusak atau tidak bisa dibaca. Coba file lain.')

/**
 * Validates, resizes and compresses a picked image. Returns a JPEG data URL no
 * longer than `maxDataUrlLength`. The second argument may be a number (longest
 * edge) for compatibility with existing callers.
 */
export async function optimizeImageFile(file: Blob, options: number | OptimizeImageOptions = {}, codec: ImageCodec = browserImageCodec): Promise<string> {
  const opts = typeof options === 'number' ? { maxEdge: options } : options
  const maxEdge = Math.max(IMAGE_LIMITS.inputMinEdge, Math.min(opts.maxEdge ?? IMAGE_LIMITS.outputMaxEdge, 1600))
  const quality = opts.quality ?? 0.85
  const maxLength = Math.min(opts.maxDataUrlLength ?? IMAGE_LIMITS.outputMaxDataUrlLength, IMAGE_LIMITS.outputMaxDataUrlLength)

  if (file.size > IMAGE_LIMITS.inputMaxBytes) {
    throw new PosError('IMAGE_TOO_LARGE', `File gambar terlalu besar (maks ${IMAGE_LIMITS.inputMaxBytes / 1024 / 1024} MB).`, { size: file.size })
  }
  if (file.type && !IMAGE_LIMITS.inputTypes.includes(file.type)) {
    throw new PosError('IMAGE_INVALID_TYPE', 'Format gambar tidak didukung. Gunakan JPG, PNG, atau WebP.', { type: file.type })
  }
  if (file.size === 0) throw decodeFailed()

  let head: Uint8Array
  try { head = await readHead(file, HEAD_BYTES) } catch { throw decodeFailed() }
  const sniffed = sniffImage(head)
  if (!sniffed) {
    // A declared image type with an unreadable header is a damaged file; anything else is the wrong format.
    if (file.type) throw decodeFailed()
    throw new PosError('IMAGE_INVALID_TYPE', 'Format gambar tidak didukung. Gunakan JPG, PNG, atau WebP.')
  }
  const checkDimensions = (width: number, height: number) => {
    if (Math.min(width, height) < IMAGE_LIMITS.inputMinEdge || width * height > IMAGE_LIMITS.inputMaxPixels) {
      throw new PosError('IMAGE_DIMENSIONS', `Ukuran piksel gambar tidak didukung (${width}×${height}). Maks ${IMAGE_LIMITS.inputMaxPixels / 1_000_000} MP, sisi terpendek ≥ ${IMAGE_LIMITS.inputMinEdge} px.`, { width, height })
    }
  }
  checkDimensions(sniffed.width, sniffed.height)

  let decoded: DecodedImage
  try { decoded = await codec.decode(file) } catch { throw decodeFailed() }
  try {
    checkDimensions(decoded.width, decoded.height)
    for (const edge of [maxEdge, Math.round(maxEdge * 0.75), Math.round(maxEdge * 0.5)]) {
      const size = fit(decoded.width, decoded.height, edge)
      for (const q of [quality, Math.min(quality, 0.72), Math.min(quality, 0.6)]) {
        let url: string
        try { url = await codec.encode(decoded, size.width, size.height, q) } catch { throw decodeFailed() }
        if (url.length > maxLength) continue
        checkImageDataUrl(url, maxLength)
        return url
      }
    }
  } finally {
    decoded.close?.()
  }
  throw new PosError('IMAGE_TOO_LARGE', 'Gambar tetap terlalu besar setelah dikompres. Coba foto lain atau potong dulu.')
}
