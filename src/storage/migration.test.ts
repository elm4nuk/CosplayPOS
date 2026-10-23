import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalPosService, type LocalPosService } from '../services/localPosService'
import { BACKUP_FORMAT } from './backup'
import { V1_TABLES, type StockMovementRow, type TransactionRow } from './db'

/**
 * Fixture written with the schema exactly as v1 shipped (copied, not imported,
 * so a later edit of db.ts cannot silently change what "v1" means here).
 */
const V1_STORES = {
  meta: 'key',
  categories: 'id, sortOrder',
  products: 'id, categoryId',
  events: 'id, createdAt',
  transactions: 'id, &number, seq, eventId, createdAt',
  stockMovements: 'id, variantId, createdAt, transactionId',
}

const photo = `data:image/jpeg;base64,${'Q'.repeat(400)}`
const at = '2026-10-15T03:00:00.000Z'
const line = (variantId: string, price: number, quantity: number, name = 'Print Cosmic') => ({ productId: 'p-1', productName: name, variantId, variantName: variantId === 'v-a5' ? 'A5' : 'A4', sku: '', price, quantity })

const v1Rows = {
  meta: [
    { key: 'createdAt', value: at }, { key: 'activeEventId', value: 'ev-1' }, { key: 'txSeq', value: 3 },
    { key: 'settings', value: { shopName: 'Booth Lama', footer: '', receiptPrefix: 'OLD', defaultCashier: 'Rin' } },
    { key: 'bundles', value: [{ id: 'b-1', name: 'Duo', description: '', price: 55000, items: [{ productId: 'p-1', variantId: 'v-a5', quantity: 1 }, { productId: 'p-1', variantId: 'v-a4', quantity: 1 }], active: true }] },
    { key: 'pin:cashier', value: { hash: 'lama' } },
  ],
  categories: [{ id: 'cat-1', name: 'Print', color: '#fff', sortOrder: 0 }],
  products: [
    { id: 'p-1', name: 'Print Cosmic', categoryId: 'cat-1', description: '', accent: '#fff', image: photo, featured: false, archived: false, variants: [{ id: 'v-a5', name: 'A5', price: 25000, stock: 7, sku: '' }, { id: 'v-a4', name: 'A4', price: 40000, stock: 4, sku: '' }], createdAt: at, updatedAt: at },
    { id: 'p-2', name: 'Stiker Lama', categoryId: 'cat-1', description: '', accent: '#fff', featured: false, archived: true, variants: [{ id: 'v-s', name: 'Default', price: 5000, stock: 0, sku: '' }], createdAt: at, updatedAt: at },
  ],
  events: [{ id: 'ev-1', name: 'Event pertama', venue: '', dateLabel: '15 Okt 2026', createdAt: at }],
  transactions: [
    // v1 rows: no paymentMethod on old cash sales, QRIS without confirmation, discount trusted from the UI.
    { id: 't-1', number: 'OLD-0001', seq: 1, eventId: 'ev-1', createdAt: at, cashierName: 'Rin', items: [line('v-a5', 25000, 2)], total: 50000, cashReceived: 50000, change: 0, status: 'completed' },
    { id: 't-2', number: 'OLD-0002', seq: 2, eventId: 'ev-1', createdAt: at, cashierName: 'Rin', items: [line('v-a4', 40000, 1)], subtotal: 40000, discount: 0, total: 40000, cashReceived: 40000, change: 0, paymentMethod: 'qris', status: 'completed' },
    { id: 't-3', number: 'OLD-0003', seq: 3, eventId: 'ev-1', createdAt: at, cashierName: 'Rin', items: [line('v-a5', 25000, 1), line('v-a4', 40000, 1)], subtotal: 65000, discount: 10000, promoName: 'Duo', total: 55000, cashReceived: 60000, change: 5000, paymentMethod: 'cash', status: 'completed' },
  ],
  stockMovements: [
    { id: 'm-1', kind: 'initial', productId: 'p-1', variantId: 'v-a5', productName: 'Print Cosmic', variantName: 'A5', delta: 10, stockAfter: 10, reason: 'Stok awal', actor: 'Rin', createdAt: at },
    { id: 'm-2', kind: 'sale', productId: 'p-1', variantId: 'v-a5', productName: 'Print Cosmic', variantName: 'A5', delta: -2, stockAfter: 8, reason: 'Penjualan', actor: 'Rin', createdAt: at, transactionId: 't-1' },
    // Left behind by v1 deleteEvent(), which deleted the event's sales.
    { id: 'm-3', kind: 'sale', productId: 'p-1', variantId: 'v-a5', productName: 'Print Cosmic', variantName: 'A5', delta: -1, stockAfter: 7, reason: 'Penjualan', actor: 'Rin', createdAt: at, transactionId: 't-gone' },
  ],
}

const services: LocalPosService[] = []
const opened = (dbName: string) => { const s = createLocalPosService({ dbName, now: () => new Date('2026-10-23T03:00:00.000Z') }); services.push(s); return s }
afterEach(async () => { for (const s of services.splice(0)) { s.close(); await s.db.delete() } })

async function writeV1(dbName: string) {
  const v1 = new Dexie(dbName)
  v1.version(1).stores(V1_STORES)
  await v1.open()
  for (const name of V1_TABLES) await v1.table(name).bulkAdd(structuredClone(v1Rows[name]))
  v1.close()
}

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

describe('migrasi Dexie v1 → v2', () => {
  it('membuka database v1 tanpa kehilangan transaksi, produk, varian, atau stok', async () => {
    const dbName = `mig-${crypto.randomUUID()}`
    await writeV1(dbName)
    const service = opened(dbName)
    expect(await service.ready()).toEqual({ firstRun: false })
    expect(service.db.verno).toBe(2)

    // Transactions: every v1 field identical, plus explicit method and payment status.
    const txs = await service.db.transactions.orderBy('seq').toArray()
    expect(txs).toHaveLength(3)
    txs.forEach((tx, i) => expect(tx).toMatchObject(v1Rows.transactions[i]))
    expect(txs.map((t) => [t.paymentMethod, t.paymentStatus])).toEqual([['cash', 'confirmed'], ['qris', 'legacy'], ['cash', 'confirmed']])

    // Products and variants identical; the photo moved to `images` byte-for-byte.
    const products = await service.db.products.toArray()
    expect(products.map((p) => p.variants)).toEqual(v1Rows.products.map((p) => p.variants))
    const p1 = products.find((p) => p.id === 'p-1')!
    expect(p1.image).toBeUndefined()
    expect(await service.db.images.get(p1.imageId!)).toMatchObject({ dataUrl: photo, mime: 'image/jpeg' })
    expect(products.find((p) => p.id === 'p-2')).toMatchObject({ archived: true })

    expect(await service.db.events.toArray()).toEqual([{ ...v1Rows.events[0], archived: false }])
    expect(await service.db.bundles.toArray()).toMatchObject([{ id: 'b-1', name: 'Duo', price: 55000, active: true, items: (v1Rows.meta[4].value as { items: unknown }[])[0].items }])
    expect(await service.db.meta.get('bundles')).toBeUndefined()
    expect(await service.db.meta.get('pin:cashier')).toBeUndefined()

    // Stock history kept; the dangling sale no longer claims a transaction id.
    const moves = new Map((await service.db.stockMovements.toArray()).map((m) => [m.id, m] as const))
    expect(moves.size).toBe(3)
    expect(moves.get('m-2')).toEqual(v1Rows.stockMovements[1])
    const orphan = moves.get('m-3') as StockMovementRow
    expect(orphan.transactionId).toBeUndefined()
    expect(orphan).toMatchObject({ legacyTransactionId: 't-gone', delta: -1, stockAfter: 7 })
  })

  it('setelah migrasi aplikasi tetap bisa jual, void, pakai bundle lama, dan struk QRIS lama jujur', async () => {
    const dbName = `mig-${crypto.randomUUID()}`
    await writeV1(dbName)
    const service = opened(dbName)
    const data = await service.getBootstrap()
    expect(data.products.map((p) => p.id)).toEqual(['p-1'])
    expect(data.products[0].image).toBe(photo)
    expect(data.archivedProducts?.map((p) => p.id)).toEqual(['p-2'])
    expect(data.bundles).toMatchObject([{ id: 'b-1' }])

    expect(await service.getReceiptText('t-2')).toContain('QRIS (data lama)')
    expect(await service.getEventReport('ev-1')).toMatchObject({ revenue: 145000, legacyQrisCount: 1, discountTotal: 10000 })

    await service.voidTransaction('t-1', 'Uji migrasi')
    expect((await service.db.products.get('p-1'))?.variants[0].stock).toBe(9)
    const sale = await service.createTransaction({ eventId: 'ev-1', items: [{ productId: 'p-1', variantId: 'v-a5', quantity: 1 }, { productId: 'p-1', variantId: 'v-a4', quantity: 1 }], cashReceived: 55000, bundleId: 'b-1' })
    expect(sale).toMatchObject({ number: 'OLD-0004', total: 55000, discount: 10000 })
  })

  it('restore file backup v1 menghasilkan data yang sama dengan upgrade di tempat', async () => {
    const inPlace = opened(`mig-${crypto.randomUUID()}`)
    await writeV1(inPlace.db.name)
    await inPlace.ready()

    const data = structuredClone(v1Rows)
    const v1File = { format: BACKUP_FORMAT, schemaVersion: 1, exportedAt: at, counts: Object.fromEntries(V1_TABLES.map((n) => [n, data[n].length])), checksum: await sha256Hex(JSON.stringify(data)), data }
    const restored = opened(`mig-${crypto.randomUUID()}`)
    await restored.ready()
    const result = await restored.restoreBackup(JSON.stringify(v1File))
    expect(result.upgradedFrom).toBe(1)
    expect(result.restored).toMatchObject({ transactions: 3, products: 2, images: 1, bundles: 1, stockMovements: 3 })

    // Generated values (image ids, migration timestamps) differ by design; everything else must match.
    const normalize = async (s: LocalPosService) => ({
      transactions: await s.db.transactions.orderBy('seq').toArray() as TransactionRow[],
      stockMovements: await s.db.stockMovements.orderBy('id').toArray(),
      events: await s.db.events.toArray(),
      products: (await s.db.products.toArray()).map(({ imageId, ...p }) => ({ ...p, hasImage: Boolean(imageId) })),
      images: (await s.db.images.toArray()).map((i) => i.dataUrl),
      bundles: (await s.db.bundles.toArray()).map((b) => ({ id: b.id, name: b.name, description: b.description, price: b.price, items: b.items, active: b.active })),
      meta: (await s.db.meta.toArray()).filter((m) => m.key !== 'createdAt'),
    })
    expect(await normalize(restored)).toEqual(await normalize(inPlace))
  })

  it('menolak backup v1 yang checksum-nya rusak sebelum migrasi', async () => {
    const service = opened(`mig-${crypto.randomUUID()}`)
    await service.ready()
    const data = structuredClone(v1Rows)
    const file = { format: BACKUP_FORMAT, schemaVersion: 1, exportedAt: at, counts: Object.fromEntries(V1_TABLES.map((n) => [n, data[n].length])), checksum: '0'.repeat(64), data }
    await expect(service.restoreBackup(JSON.stringify(file))).rejects.toMatchObject({ code: 'BACKUP_INVALID' })
    expect(await service.db.transactions.count()).toBe(0)
  })
})
