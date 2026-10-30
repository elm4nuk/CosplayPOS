import { PosError } from './errors'

/**
 * Image limits shared by the picker (`src/platform/images.ts`), the service
 * (every write is re-checked) and backup restore.
 *
 * Budget: a product photo is a ≤ 640 px JPEG of at most ~200 KB. 200 products
 * with photos stay under ~40 MB of strings in the worst case and ~8 MB at the
 * typical 40 KB per photo, which the bootstrap and a JSON backup can hold on a
 * low-end phone.
 */
export const IMAGE_LIMITS = {
  /** Accepted picker inputs. HEIC/GIF/SVG are rejected (WebView can't decode HEIC, SVG can carry script). */
  inputTypes: ['image/jpeg', 'image/png', 'image/webp'] as readonly string[],
  /** Largest file read from the picker. Bigger files are rejected before decoding. */
  inputMaxBytes: 15 * 1024 * 1024,
  /** Largest decoded size (width × height). 40 MP ≈ 160 MB of RGBA, the most a mid phone survives. */
  inputMaxPixels: 40_000_000,
  inputMinEdge: 16,
  /** Default longest edge of the stored image. */
  outputMaxEdge: 640,
  /** Hard cap on the stored data URL (≈ 200 KB binary). Enforced on every service write. */
  outputMaxDataUrlLength: 280_000,
  /** Restore accepts larger legacy photos saved by v1 (which could store the original file). */
  restoredMaxDataUrlLength: 8_000_000,
} as const

const STORED_DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,[A-Za-z0-9+/]+={0,2}$/

/** Validates a data URL before it is stored. Returns its MIME type and length. */
export function checkImageDataUrl(value: string, maxLength: number = IMAGE_LIMITS.outputMaxDataUrlLength) {
  if (value.length > maxLength) {
    throw new PosError('IMAGE_TOO_LARGE', `Gambar terlalu besar untuk disimpan (maks ${Math.round(maxLength / 1370)} KB). Pilih ulang gambar agar dikompres.`, { length: value.length, maxLength })
  }
  const match = STORED_DATA_URL.exec(value)
  if (!match) throw new PosError('IMAGE_INVALID_TYPE', 'Format gambar tidak didukung. Gunakan JPG, PNG, atau WebP.')
  return { mime: match[1], bytes: value.length }
}
