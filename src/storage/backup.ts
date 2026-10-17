import { DATA_TABLES, SCHEMA_VERSION, type DataTableName, type PosDatabase } from './db'
import { PosError } from './errors'

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
  data: BackupData
}


async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function createBackup(db: PosDatabase, now = new Date()): Promise<BackupFile> {
  // One read transaction = one consistent snapshot, even if a sale lands meanwhile.
  const data = await db.transaction('r', DATA_TABLES.map((name) => db.table(name)), async () => {
    const entries = await Promise.all(DATA_TABLES.map(async (name) => [name, await db.table(name).toArray()] as const))
    return Object.fromEntries(entries) as BackupData
  })
  data.meta = (data.meta as { key: string }[]).filter((row) => !isLocalOnlyMetaKey(row.key))
  const counts = Object.fromEntries(DATA_TABLES.map((name) => [name, data[name].length])) as BackupFile['counts']
  return { format: BACKUP_FORMAT, schemaVersion: SCHEMA_VERSION, exportedAt: now.toISOString(), counts, checksum: await sha256Hex(JSON.stringify(data)), data }
}

const invalid = (why: string): never => { throw new PosError('BACKUP_INVALID', `File backup tidak bisa dipakai: ${why}`) }
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown) => typeof v === 'string' && v.length > 0
const isInt = (v: unknown, min = -Infinity) => Number.isSafeInteger(v) && (v as number) >= min

function checkRows(data: BackupData) {
  const ids = (name: DataTableName) => new Set((data[name] as { id: string }[]).map((r) => r.id))
  for (const name of DATA_TABLES) {
    for (const row of data[name]) if (!isObj(row) || !isStr(name === 'meta' ? row.key : row.id)) invalid(`baris ${name} tanpa ID.`)
  }
  const categoryIds = ids('categories')
  for (const p of data.products as Record<string, unknown>[]) {
    if (!isStr(p.name) || !categoryIds.has(p.categoryId as string) || !Array.isArray(p.variants)) invalid(`produk ${String(p.id)} rusak.`)
    for (const v of p.variants as Record<string, unknown>[]) {
      if (!isObj(v) || !isStr(v.id) || !isInt(v.price, 0) || !isInt(v.stock, 0)) invalid(`varian di produk ${String(p.name)} rusak.`)
    }
  }
  const eventIds = ids('events')
  for (const t of data.transactions as Record<string, unknown>[]) {
    if (!isStr(t.number) || !eventIds.has(t.eventId as string) || !isInt(t.total, 0) || !isInt(t.cashReceived, 0) || !Array.isArray(t.items)) invalid(`transaksi ${String(t.number ?? t.id)} rusak.`)
    const sum = (t.items as Record<string, unknown>[]).reduce((acc, item) => acc + (item.price as number) * (item.quantity as number), 0)
    const discount = (t.discount as number) || 0
    if (sum - discount !== t.total) invalid(`total transaksi ${String(t.number)} tidak cocok dengan itemnya.`)
  }
  for (const m of data.stockMovements as Record<string, unknown>[]) {
    if (!isInt(m.delta) || !isInt(m.stockAfter, 0)) invalid('riwayat stok rusak.')
  }
}

/** Parses and fully validates a backup file. Throws BACKUP_INVALID with a readable reason. */
export async function parseBackup(text: string): Promise<BackupFile> {
  let file: unknown
  try { file = JSON.parse(text) } catch { return invalid('bukan file JSON.') }
  if (!isObj(file) || file.format !== BACKUP_FORMAT) invalid('bukan backup CosplayPOS.')
  const backup = file as BackupFile
  if (!isInt(backup.schemaVersion, 1)) invalid('versi skema tidak dikenal.')
  if (backup.schemaVersion > SCHEMA_VERSION) invalid(`dibuat oleh versi aplikasi yang lebih baru (skema ${backup.schemaVersion}). Perbarui aplikasi dulu.`)
  if (!isObj(backup.data) || DATA_TABLES.some((name) => !Array.isArray(backup.data[name]))) invalid('isi data tidak lengkap.')
  if ((await sha256Hex(JSON.stringify(backup.data))) !== backup.checksum) invalid('checksum tidak cocok (file terpotong atau diubah).')
  for (const name of DATA_TABLES) if (backup.counts?.[name] !== backup.data[name].length) invalid(`jumlah ${name} tidak cocok.`)
  checkRows(backup.data)
  return backup
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
