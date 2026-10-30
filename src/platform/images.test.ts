import { describe, expect, it, vi } from 'vitest'
import { isPosError, type PosErrorCode } from '../storage/errors'
import { IMAGE_LIMITS } from '../storage/images'
import { optimizeImageFile, sniffImage, type DecodedImage, type ImageCodec } from './images'

const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff]
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]
const bytes = (...parts: (number[] | string)[]) => new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)))

const png = (w: number, h: number) => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], u32be(13), 'IHDR', u32be(w), u32be(h), [8, 6, 0, 0, 0], [0, 0, 0, 0])
// SOI, an APP1 segment the parser must skip, then SOF0 with the frame size.
const jpeg = (w: number, h: number) => bytes([0xff, 0xd8, 0xff, 0xe1], u16be(8), 'Exif\0\0', [0xff, 0xc0], u16be(17), [8], u16be(h), u16be(w), [3], new Array(9).fill(0), [0xff, 0xd9])
const webpX = (w: number, h: number) => bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8X', [10, 0, 0, 0], [0, 0, 0, 0], u24le(w - 1), u24le(h - 1))
const webpLossy = (w: number, h: number) => bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8 ', [0, 0, 0, 0], [0, 0, 0], [0x9d, 0x01, 0x2a], [w & 0xff, w >> 8], [h & 0xff, h >> 8])
const webpLossless = (w: number, h: number) => {
  const bits = (w - 1) | ((h - 1) << 14)
  return bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8L', [0, 0, 0, 0], [0x2f], [bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff])
}

const file = (data: Uint8Array, type = 'image/jpeg') => new Blob([data], { type })

/** Fake canvas: decode reports the size it is told; encode returns a data URL of `size(w, h, q)` base64 chars. */
function fakeCodec(width: number, height: number, size: (w: number, h: number, q: number) => number = () => 1000) {
  const close = vi.fn()
  const codec: ImageCodec & { calls: [number, number, number][] } = {
    calls: [],
    decode: vi.fn(async (): Promise<DecodedImage> => ({ width, height, source: {} as CanvasImageSource, close })),
    async encode(_image, w, h, q) {
      codec.calls.push([w, h, q])
      return `data:image/jpeg;base64,${'A'.repeat(Math.ceil(size(w, h, q) / 4) * 4)}`
    },
  }
  return { codec, close }
}

const code = async (promise: Promise<unknown>): Promise<PosErrorCode | 'resolved'> => {
  try { await promise; return 'resolved' } catch (reason) { if (isPosError(reason)) return reason.code; throw reason }
}

describe('sniffImage membaca format asli dari header', () => {
  it('mengenali PNG, JPEG, dan tiga varian WebP beserta ukurannya', () => {
    expect(sniffImage(png(1200, 800))).toEqual({ mime: 'image/png', width: 1200, height: 800 })
    expect(sniffImage(jpeg(4032, 3024))).toEqual({ mime: 'image/jpeg', width: 4032, height: 3024 })
    expect(sniffImage(webpX(5000, 4000))).toEqual({ mime: 'image/webp', width: 5000, height: 4000 })
    expect(sniffImage(webpLossy(640, 480))).toEqual({ mime: 'image/webp', width: 640, height: 480 })
    expect(sniffImage(webpLossless(300, 200))).toEqual({ mime: 'image/webp', width: 300, height: 200 })
  })

  it('mengembalikan null untuk GIF, SVG, dan byte acak', () => {
    expect(sniffImage(bytes('GIF89a', [1, 0, 1, 0]))).toBeNull()
    expect(sniffImage(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(sniffImage(new Uint8Array(64).map((_, i) => (i * 37) % 251))).toBeNull()
    expect(sniffImage(bytes([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBeNull()
  })
})

describe('optimizeImageFile memvalidasi sebelum decode dan tidak pernah menyimpan file asli', () => {
  it('menolak file terlalu besar tanpa membacanya', async () => {
    const { codec } = fakeCodec(100, 100)
    const big = file(new Uint8Array(IMAGE_LIMITS.inputMaxBytes + 1))
    expect(await code(optimizeImageFile(big, {}, codec))).toBe('IMAGE_TOO_LARGE')
    expect(codec.decode).not.toHaveBeenCalled()
  })

  it('menolak format yang tidak didukung', async () => {
    const { codec } = fakeCodec(100, 100)
    expect(await code(optimizeImageFile(file(bytes('GIF89a', [1, 0, 1, 0]), 'image/gif'), {}, codec))).toBe('IMAGE_INVALID_TYPE')
    expect(await code(optimizeImageFile(file(png(10, 10), 'image/heic'), {}, codec))).toBe('IMAGE_INVALID_TYPE')
    expect(await code(optimizeImageFile(file(bytes('bukan gambar sama sekali'), ''), {}, codec))).toBe('IMAGE_INVALID_TYPE')
    expect(codec.decode).not.toHaveBeenCalled()
  })

  it('file rusak berlabel gambar → IMAGE_DECODE_FAILED, baik header rusak maupun decoder gagal', async () => {
    const { codec } = fakeCodec(100, 100)
    expect(await code(optimizeImageFile(file(bytes([0xff, 0xd8, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09])), {}, codec))).toBe('IMAGE_DECODE_FAILED')
    expect(await code(optimizeImageFile(file(new Uint8Array(0)), {}, codec))).toBe('IMAGE_DECODE_FAILED')
    expect(codec.decode).not.toHaveBeenCalled()

    const broken: ImageCodec = { decode: async () => { throw new Error('decode error') }, encode: async () => 'data:image/jpeg;base64,AAAA' }
    expect(await code(optimizeImageFile(file(jpeg(800, 600)), {}, broken))).toBe('IMAGE_DECODE_FAILED')
  })

  it('menolak dimensi ekstrem dari header sebelum decode', async () => {
    const { codec } = fakeCodec(10000, 10000)
    expect(await code(optimizeImageFile(file(png(10000, 10000), 'image/png'), {}, codec))).toBe('IMAGE_DIMENSIONS')
    expect(await code(optimizeImageFile(file(png(4000, 8), 'image/png'), {}, codec))).toBe('IMAGE_DIMENSIONS')
    expect(codec.decode).not.toHaveBeenCalled()
  })

  it('memperkecil dan menurunkan kualitas sampai muat, lalu membebaskan bitmap', async () => {
    // Too big unless quality ≤ 0.72 at 640 px.
    const { codec, close } = fakeCodec(4000, 3000, (w, _h, q) => (q > 0.72 ? 400_000 : w * 100))
    const url = await optimizeImageFile(file(jpeg(4000, 3000)), {}, codec)
    expect(codec.calls).toEqual([[640, 480, 0.85], [640, 480, 0.72]])
    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(url.length).toBeLessThanOrEqual(IMAGE_LIMITS.outputMaxDataUrlLength)
    expect(close).toHaveBeenCalledOnce()
  })

  it('argumen angka tetap berarti sisi terpanjang (kompatibel dengan pemanggil lama)', async () => {
    const { codec } = fakeCodec(3000, 4000)
    await optimizeImageFile(file(webpX(3000, 4000), 'image/webp'), 800, codec)
    expect(codec.calls[0]).toEqual([600, 800, 0.85])
  })

  it('output yang tetap terlalu besar → IMAGE_TOO_LARGE; output bukan JPEG/PNG/WebP → IMAGE_INVALID_TYPE', async () => {
    const { codec, close } = fakeCodec(2000, 2000, () => 1_000_000)
    expect(await code(optimizeImageFile(file(png(2000, 2000), 'image/png'), {}, codec))).toBe('IMAGE_TOO_LARGE')
    expect(codec.calls).toHaveLength(9)
    expect(close).toHaveBeenCalledOnce()

    const gifOut: ImageCodec = { decode: fakeCodec(100, 100).codec.decode, encode: async () => 'data:image/gif;base64,AAAA' }
    expect(await code(optimizeImageFile(file(png(100, 100), 'image/png'), {}, gifOut))).toBe('IMAGE_INVALID_TYPE')
  })
})
