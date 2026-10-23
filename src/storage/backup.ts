import { DATA_TABLES, SCHEMA_VERSION, V1_TABLES, migrateV1toV2, type DataTableName, type PosDatabase, type V1Data } from './db'
import { PosError, isPosError } from './errors'
import { IMAGE_LIMITS, checkImageDataUrl } from './images'

export const BACKUP_FORMAT = 'cosplaypos-backup'

/**
 * Meta rows that must never leave this device and never come back in.
 *
 * `pin:*` / `pinGuard:*` are leftovers from the removed PIN gate (the MVP opens
 * straight to the till, docs/HANDOFF.md § 1.7). New exports drop them, and a
 * backup made by an older build is still accepted — the rows are simply not
 * restored, so an old file can never reintroduce a login step.
 */
export const isLocalOnlyMetaKey = (key: string) => key.startsWith('pin:') || key.startsWith('pinGuard:')

export type BackupData = Record<DataTableName, unknown[]>

export type BackupFile = {
  format: typeof BACKUP_FORMAT
  schemaVersion: number
  exportedAt: string
  counts: Record<DataTableName, number>
  /** SHA-256 hex of JSON.stringify(data). Detects truncated or edited files. */
  checksum: string
  /** Product photos travel inside `data.images` (compressed JPEG data URLs); nothing is kept outside the file. */
  data: BackupData
  /** Set by `parseBackup` when an older file was migrated in memory before restore. */
  upgradedFrom?: number
}


async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

const countsOf = (data: BackupData) => Object.fromEntries(DATA_TABLES.map((name) => [name, data[name].length])) as BackupFile['counts']

export async function createBackup(db: PosDatabase, now = new Date()): Promise<BackupFile> {
  // One read transaction = one consistent snapshot, even if a sale lands meanwhile.
  const data = await db.transaction('r', DATA_TABLES.map((name) => db.table(name)), async () => {
    const entries = await Promise.all(DATA_TABLES.map(async (name) => [name, await db.table(name).toArray()] as const))
    return Object.fromEntries(entries) as BackupData
  })
  data.meta = (data.meta as { key: string }[]).filter((row) => !isLocalOnlyMetaKey(row.key))
  return { format: BACKUP_FORMAT, schemaVersion: SCHEMA_VERSION, exportedAt: now.toISOString(), counts: countsOf(data), checksum: await sha256Hex(JSON.stringify(data)), data }
}

const invalid = (why: string): never => { throw new PosError('BACKUP_INVALID', `File backup tidak bisa dipakai: ${why}`) }
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown) => typeof v === 'string' && v.length > 0
const isInt = (v: unknown, min = -Infinity) => Number.isSafeInteger(v) && (v as number) >= min
const optional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v)

type Row = Record<string, unknown>

function checkRows(data: BackupData) {
  const rows = (name: DataTableName) => data[name] as Row[]
  const ids = (name: DataTableName) => new Set(rows(name).map((r) => r.id as string))
  for (const name of DATA_TABLES) {
    for (const row of data[name]) if (!isObj(row) || !isStr(name === 'meta' ? row.key : row.id)) invalid(`baris ${name} tanpa ID.`)
  }

  const imageIds = ids('images')
  for (const image of rows('images')) {
    if (typeof image.dataUrl !== 'string') invalid(`gambar ${String(image.id)} rusak.`)
    try { checkImageDataUrl(image.dataUrl as string, IMAGE_LIMITS.restoredMaxDataUrlLength) } catch (reason) {
      if (isPosError(reason)) invalid(`gambar ${String(image.id)} rusak atau terlalu besar.`)
      throw reason
    }
  }

  const categoryIds = ids('categories')
  for (const p of rows('products')) {
    // Older builds let a category be deleted while archived products still used it; unarchiveProduct() guards that case.
    if (!isStr(p.name) || (!p.archived && !categoryIds.has(p.categoryId as string)) || !Array.isArray(p.variants)) invalid(`produk ${String(p.id)} rusak.`)
    if (!optional(p.imageId, (v) => imageIds.has(v as string))) invalid(`foto produk ${String(p.name)} tidak ada di file.`)
    for (const v of p.variants as Row[]) {
      if (!isObj(v) || !isStr(v.id) || !isInt(v.price, 0) || !isInt(v.stock, 0) || !optional(v.lowStockThreshold, (n) => isInt(n, 0))) invalid(`varian di produk ${String(p.name)} rusak.`)
    }
  }

  const events = rows('events')
  if (!events.some((e) => e.archived !== true)) invalid('tidak ada event yang aktif (semua diarsipkan).')
  const eventIds = ids('events')
  for (const b of rows('bundles')) {
    if (!isStr(b.name) || !isInt(b.price, 0) || !Array.isArray(b.items)) invalid(`bundle ${String(b.id)} rusak.`)
    for (const item of b.items as Row[]) {
      // Bundles may point at products deleted later (checkout then rejects them), but the shape must hold.
      if (!isObj(item) || !isStr(item.productId) || !isStr(item.variantId) || !isInt(item.quantity, 1)) invalid(`isi bundle ${String(b.name)} rusak.`)
    }
  }

  const txIds = ids('transactions')
  for (const t of rows('transactions')) {
    if (!isStr(t.number) || !eventIds.has(t.eventId as string) || !isInt(t.total, 0) || !isInt(t.cashReceived, 0) || !Array.isArray(t.items)) invalid(`transaksi ${String(t.number ?? t.id)} rusak.`)
    if (!['cash', 'qris'].includes(t.paymentMethod as string) || !['confirmed', 'legacy'].includes(t.paymentStatus as string)) invalid(`metode/status bayar transaksi ${String(t.number)} rusak.`)
    const sum = (t.items as Row[]).reduce((acc, item) => acc + (item.price as number) * (item.quantity as number), 0)
    const discount = (t.discount as number) || 0
    if (sum - discount !== t.total) invalid(`total transaksi ${String(t.number)} tidak cocok dengan itemnya.`)
    if (t.promo !== undefined) {
      const promo = t.promo as Row
      if (!isObj(promo) || promo.discount !== discount || (promo.normalPrice as number) - (promo.bundlePrice as number) !== discount) invalid(`promo transaksi ${String(t.number)} tidak cocok.`)
    }
  }
  for (const m of rows('stockMovements')) {
    if (!isInt(m.delta) || !isInt(m.stockAfter, 0)) invalid('riwayat stok rusak.')
    if (m.transactionId !== undefined && !txIds.has(m.transactionId as string)) invalid('riwayat stok merujuk transaksi yang tidak ada.')
  }
  for (const s of rows('cashSessions')) {
    if (!['open', 'closed'].includes(s.status as string) || !isInt(s.openingCash, 0) || !eventIds.has(s.eventId as string)) invalid(`sesi kas ${String(s.id)} rusak.`)
  }
  if (rows('cashSessions').filter((s) => s.status === 'open').length > 1) invalid('lebih dari satu sesi kas terbuka.')
}

/**
 * Parses and fully validates a backup file. Throws BACKUP_INVALID with a readable reason.
 * A file from an older schema is verified as written (checksum, counts), then
 * migrated in memory with the same transform the database upgrade uses.
 */
export async function parseBackup(text: string): Promise<BackupFile> {
  let file: unknown
  try { file = JSON.parse(text) } catch { return invalid('bukan file JSON.') }
  if (!isObj(file) || file.format !== BACKUP_FORMAT) invalid('bukan backup CosplayPOS.')
  const backup = file as BackupFile
  if (!isInt(backup.schemaVersion, 1)) invalid('versi skema tidak dikenal.')
  if (backup.schemaVersion > SCHEMA_VERSION) invalid(`dibuat oleh versi aplikasi yang lebih baru (skema ${backup.schemaVersion}). Perbarui aplikasi dulu.`)
  const tables: readonly DataTableName[] = backup.schemaVersion === 1 ? V1_TABLES : DATA_TABLES
  if (!isObj(backup.data) || tables.some((name) => !Array.isArray(backup.data[name]))) invalid('isi data tidak lengkap.')
  if ((await sha256Hex(JSON.stringify(backup.data))) !== backup.checksum) invalid('checksum tidak cocok (file terpotong atau diubah).')
  for (const name of tables) if (backup.counts?.[name] !== backup.data[name].length) invalid(`jumlah ${name} tidak cocok.`)

  let result = backup
  if (backup.schemaVersion === 1) {
    for (const t of backup.data.transactions) if (!isObj(t)) invalid('baris transactions rusak.')
    for (const p of backup.data.products) if (!isObj(p)) invalid('baris products rusak.')
    for (const m of backup.data.meta) if (!isObj(m)) invalid('baris meta rusak.')
    const data = migrateV1toV2(backup.data as V1Data, { now: backup.exportedAt ?? new Date().toISOString(), newId: () => crypto.randomUUID() }) as unknown as BackupData
    result = { ...backup, schemaVersion: SCHEMA_VERSION, counts: countsOf(data), checksum: await sha256Hex(JSON.stringify(data)), data, upgradedFrom: 1 }
  }
  checkRows(result.data)
  return result
}

/**
 * Replaces ALL local data with the backup in one atomic transaction. Device-local
 * meta rows (see `isLocalOnlyMetaKey`) are dropped instead of restored.
 */
export async function restoreBackup(db: PosDatabase, backup: BackupFile) {
  await db.transaction('rw', DATA_TABLES.map((name) => db.table(name)), async () => {
    for (const name of DATA_TABLES) {
      const rows = name === 'meta' ? (backup.data.meta as { key: string }[]).filter((row) => !isLocalOnlyMetaKey(row.key)) : backup.data[name]
      const table = db.table(name)
      await table.clear()
      await table.bulkAdd(rows)
    }
  })
}
