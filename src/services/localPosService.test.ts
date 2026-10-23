import 'fake-indexeddb/auto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isPosError, type PosErrorCode } from '../storage/errors'
import { RECEIPT_COLUMNS } from '../storage/receipt'
import { initialMockData } from '../data/mockData'
import { seedDemoCatalog } from '../testing/demoCatalog'
import { createLocalPosService, type LocalPosService } from './localPosService'

let dbName = ''
let service: LocalPosService
let clock = new Date('2026-10-17T10:00:00+07:00')
const extraServices: LocalPosService[] = []

const code = async (promise: Promise<unknown>): Promise<PosErrorCode | 'resolved'> => {
  try { await promise; return 'resolved' } catch (reason) { if (isPosError(reason)) return reason.code; throw reason }
}
const failure = async (promise: Promise<unknown>) => {
  try { await promise } catch (reason) { if (isPosError(reason)) return reason; throw reason }
  throw new Error('expected PosError')
}
const open = (name = dbName, options: Parameters<typeof createLocalPosService>[0] = {}) => createLocalPosService({ dbName: name, now: () => clock, ...options })

async function seeded() {
  await service.ready()
  await service.saveSettings({ defaultCashier: 'Kasir Demo', shopName: 'Booth Bintang' })
  const category = await service.saveCategory({ name: 'Print' })
  const product = await service.saveProduct({ name: 'Print Cosmic', categoryId: category.id, variants: [{ name: 'A5', price: 25000, stock: 3, sku: 'A5' }, { name: 'A4', price: 40000, stock: 1 }] })
  const data = await service.getBootstrap()
  return { product, a5: product.variants[0], a4: product.variants[1], eventId: data.events[0].id }
}

const stockOf = async (variantId: string) => (await service.getBootstrap()).products.flatMap((p) => p.variants).find((v) => v.id === variantId)?.stock

beforeEach(() => { dbName = `test-${crypto.randomUUID()}`; clock = new Date('2026-10-17T10:00:00+07:00'); service = open() })
afterEach(async () => {
  for (const instance of [service, ...extraServices]) { instance.close(); await instance.db.delete() }
  extraServices.length = 0
})

describe('akses langsung tanpa autentikasi', () => {
  it('instalasi baru langsung siap dipakai dan membuat event lokal', async () => {
    expect(await service.ready()).toEqual({ firstRun: true })
    expect((await service.getBootstrap()).events).toHaveLength(1)
    expect(await code(service.saveCategory({ name: 'Print' }))).toBe('resolved')
  })

  it('membersihkan metadata PIN lama tanpa mengubah data usaha', async () => {
    await service.db.meta.bulkPut([{ key: 'pin:cashier', value: { hash: 'lama' } }, { key: 'pinGuard:owner', value: { failures: 2 } }])
    await service.ready()
    expect(await service.db.meta.where('key').startsWith('pin:').count()).toBe(0)
    expect(await service.db.meta.where('key').startsWith('pinGuard:').count()).toBe(0)
  })

  it('semua pengaturan, termasuk prefix struk, dapat diubah tanpa PIN', async () => {
    await service.ready()
    expect(await service.saveSettings({ receiptPrefix: 'BTG', defaultCashier: 'Kasir Demo' })).toMatchObject({ receiptPrefix: 'BTG', defaultCashier: 'Kasir Demo' })
  })

  it('deleteProduct menghapus produk dari database dan katalog', async () => {
    const { product } = await seeded()
    expect((await service.getBootstrap()).products.some((p) => p.id === product.id)).toBe(true)
    await service.deleteProduct(product.id)
    expect((await service.getBootstrap()).products.some((p) => p.id === product.id)).toBe(false)
    expect(await service.db.products.get(product.id)).toBeUndefined()
  })
})

describe('checkout dan stok atomik', () => {
  it('memakai harga database, mengurangi stok, dan mencatat kasir lokal', async () => {
    const { product, a5, eventId } = await seeded()
    const tx = await service.createTransaction({ eventId, items: [{ productId: product.id, variantId: a5.id, quantity: 2, price: 1 } as never], cashReceived: 100000 })
    expect(tx).toMatchObject({ total: 50000, change: 50000, cashierName: 'Kasir Demo', status: 'completed' })
    expect(await stockOf(a5.id)).toBe(1)
    expect(await service.db.stockMovements.where('transactionId').equals(tx.id).count()).toBe(1)
  })

  it('stok 1 hanya dapat dijual sekali', async () => {
    const { product, a4, eventId } = await seeded(); const line = { productId: product.id, variantId: a4.id, quantity: 1 }
    await service.createTransaction({ eventId, items: [line], cashReceived: 40000 })
    const second = await failure(service.createTransaction({ eventId, items: [line], cashReceived: 40000 }))
    expect(second).toMatchObject({ code: 'STOCK_CHANGED', details: { shortages: [{ variantId: a4.id, available: 0 }] } })
    expect(await service.db.transactions.count()).toBe(1)
  })

  it('uang atau stok kurang tidak menghasilkan perubahan sebagian', async () => {
    const { product, a5, a4, eventId } = await seeded()
    expect(await code(service.createTransaction({ eventId, items: [{ productId: product.id, variantId: a5.id, quantity: 1 }], cashReceived: 24999 }))).toBe('INSUFFICIENT_CASH')
    expect(await code(service.createTransaction({ eventId, items: [{ productId: product.id, variantId: a5.id, quantity: 1 }, { productId: product.id, variantId: a4.id, quantity: 2 }], cashReceived: 500000 }))).toBe('STOCK_CHANGED')
    expect(await stockOf(a5.id)).toBe(3); expect(await stockOf(a4.id)).toBe(1); expect(await service.db.transactions.count()).toBe(0)
  })

  it('idempotency key mencegah tap ganda menjual dua kali', async () => {
    const { product, a5, eventId } = await seeded(); const input = { eventId, items: [{ productId: product.id, variantId: a5.id, quantity: 1 }], cashReceived: 25000, idempotencyKey: crypto.randomUUID() }
    const [first, second] = await Promise.all([service.createTransaction(input), service.createTransaction(input)])
    expect(second.id).toBe(first.id); expect(await service.db.transactions.count()).toBe(1); expect(await stockOf(a5.id)).toBe(2)
  })

  it('void wajib beralasan, menyimpan riwayat, dan mengembalikan stok', async () => {
    const { product, a5, eventId } = await seeded(); const tx = await service.createTransaction({ eventId, items: [{ productId: product.id, variantId: a5.id, quantity: 2 }], cashReceived: 50000 })
    expect(await code(service.voidTransaction(tx.id, '  '))).toBe('VALIDATION')
    const voided = await service.voidTransaction(tx.id, 'Salah pilih varian')
    expect(voided).toMatchObject({ status: 'void', voidReason: 'Salah pilih varian' }); expect(voided.voidedAt).toBeTruthy(); expect(await stockOf(a5.id)).toBe(3)
    expect(await code(service.voidTransaction(tx.id, 'ulang'))).toBe('ALREADY_VOID')
  })
})

describe('laporan, persistence, dan struk', () => {
  it('menghitung dua event secara terpisah dari transaksi tersimpan', async () => {
    const { product, a5, a4, eventId: first } = await seeded(); const second = await service.saveEvent({ name: 'Creator Alley', venue: 'Bandung' })
    await service.createTransaction({ eventId: first, items: [{ productId: product.id, variantId: a5.id, quantity: 2 }], cashReceived: 50000 })
    await service.setActiveEvent(second.id)
    await service.createTransaction({ eventId: second.id, items: [{ productId: product.id, variantId: a4.id, quantity: 1 }], cashReceived: 50000 })
    expect(await service.getEventReport(first)).toMatchObject({ revenue: 50000, transactionCount: 1, itemsSold: 2 })
    expect(await service.getEventReport(second.id)).toMatchObject({ revenue: 40000, transactionCount: 1, itemsSold: 1 })
  })

  it('produk, stok, transaksi, event, dan nomor urut bertahan setelah buka ulang', async () => {
    const { product, a5, eventId } = await seeded(); await service.createTransaction({ eventId, items: [{ productId: product.id, variantId: a5.id, quantity: 1 }], cashReceived: 25000 })
    service.close(); service = open(); expect(await service.ready()).toEqual({ firstRun: false }); expect(await stockOf(a5.id)).toBe(2)
    const next = await service.createTransaction({ eventId, items: [{ productId: product.id, variantId: a5.id, quantity: 1 }], cashReceived: 25000 })
    expect(next.number).toBe('TRX-0002'); expect((await service.getBootstrap()).transactions).toHaveLength(2)
  })

  it('struk tetap 32 kolom dan memakai nama booth', async () => {
    const { product, a5, eventId } = await seeded(); const tx = await service.createTransaction({ eventId, items: [{ productId: product.id, variantId: a5.id, quantity: 1 }], cashReceived: 50000 })
    const receipt = await service.getReceiptText(tx.id)
    expect(receipt).toContain('Booth Bintang'); expect(receipt.split('\n').every((line) => line.length <= RECEIPT_COLUMNS)).toBe(true)
  })

  it('mendukung pembayaran QRIS dan memisahkan omzet tunai vs QRIS di laporan', async () => {
    const { product, a5, eventId } = await seeded()
    const txCash = await service.createTransaction({ eventId, items: [{ productId: product.id, variantId: a5.id, quantity: 1 }], cashReceived: 30000, paymentMethod: 'cash' })
    expect(txCash).toMatchObject({ paymentMethod: 'cash', paymentStatus: 'confirmed', change: 5000 })

    const txQris = await service.createTransaction({ eventId, items: [{ productId: product.id, variantId: a5.id, quantity: 1 }], cashReceived: 0, paymentMethod: 'qris', paymentConfirmed: true })
    expect(txQris).toMatchObject({ paymentMethod: 'qris', paymentStatus: 'confirmed', paymentConfirmedBy: 'Kasir Demo', cashReceived: 25000, change: 0 })

    const report = await service.getEventReport(eventId)
    expect(report).toMatchObject({ revenue: 50000, cashRevenue: 25000, qrisRevenue: 25000, transactionCount: 2, legacyQrisCount: 0 })
  })

  it('mendukung edit produk dan mencatat riwayat penyesuaian stok saat diedit', async () => {
    const { product } = await seeded()
    // Edit produk: ubah nama, harga, dan stok dari 3 menjadi 10
    const updated = await service.saveProduct({
      id: product.id,
      name: 'Poster Art Exclusive (Updated)',
      categoryId: product.categoryId,
      description: 'Laminasi glossy premium',
      image: 'data:image/webp;base64,mockupdated',
      price: 35000,
      stock: 10,
    })

    expect(updated.name).toBe('Poster Art Exclusive (Updated)')
    expect(updated.image).toBe('data:image/webp;base64,mockupdated')
    expect(updated.variants[0].price).toBe(35000)
    expect(updated.variants[0].stock).toBe(10)

    // Cek bahwa penyesuaian stok (+7) tercatat di stockAdjustments
    const bootstrap = await service.getBootstrap()
    const adjustment = bootstrap.stockAdjustments.find((m) => m.delta === 7)
    expect(adjustment).toBeDefined()
    expect(adjustment?.reason).toContain('edit produk')
  })

  it('mendukung pembuatan, edit, toggle, dan hapus promo bundle', async () => {
    const { product, a5, a4 } = await seeded()
    // Simpan bundle baru
    const bundle = await service.saveBundle({
      name: 'Paket Cosmic Double',
      description: '1 A5 + 1 A4 dengan harga spesial',
      price: 55000, // Harga normal 25000 + 40000 = 65000 (hemat 10000)
      items: [
        { productId: product.id, variantId: a5.id, quantity: 1 },
        { productId: product.id, variantId: a4.id, quantity: 1 },
      ],
    })

    expect(bundle.name).toBe('Paket Cosmic Double')
    expect(bundle.price).toBe(55000)
    expect(bundle.active).toBe(true)

    // Cek di getBootstrap
    let bootstrap = await service.getBootstrap()
    expect(bootstrap.bundles.some((b) => b.id === bundle.id)).toBe(true)

    // Toggle active
    await service.toggleBundleActive(bundle.id)
    bootstrap = await service.getBootstrap()
    expect(bootstrap.bundles.find((b) => b.id === bundle.id)?.active).toBe(false)

    // Hapus bundle
    await service.deleteBundle(bundle.id)
    bootstrap = await service.getBootstrap()
    expect(bootstrap.bundles.some((b) => b.id === bundle.id)).toBe(false)
  })

  it('checkout bundle memakai bundleId, diskon dihitung service, dan struk mencatat diskon', async () => {
    const { product, a5, a4, eventId } = await seeded()
    const bundle = await service.saveBundle({ name: 'Paket Cosmic Double', price: 55000, items: [{ productId: product.id, variantId: a5.id, quantity: 1 }, { productId: product.id, variantId: a4.id, quantity: 1 }] })
    const tx = await service.createTransaction({ eventId, items: [{ productId: product.id, variantId: a5.id, quantity: 1 }, { productId: product.id, variantId: a4.id, quantity: 1 }], cashReceived: 60000, bundleId: bundle.id })
    expect(tx).toMatchObject({ subtotal: 65000, discount: 10000, total: 55000, change: 5000, promoName: 'Paket Cosmic Double', bundleId: bundle.id })
    expect((await service.db.transactions.get(tx.id))?.promo).toEqual({ bundleId: bundle.id, name: 'Paket Cosmic Double', bundlePrice: 55000, normalPrice: 65000, discount: 10000, items: bundle.items })
    const receipt = await service.getReceiptText(tx.id)
    expect(receipt).toContain('Subtotal'); expect(receipt).toContain('Diskon (Paket Cosmic'); expect(receipt).toContain('-Rp 10.000')
  })

  it('menghasilkan laporan perbandingan antar event secara akurat', async () => {
    const { product, a5, a4, eventId: ev1 } = await seeded()
    const ev2 = await service.saveEvent({ name: 'Anime Expo Jakarta', venue: 'Balai Kartini', dateLabel: '20 Okt 2026' })

    // Transaksi di Event 1: Omzet 50.000
    await service.createTransaction({
      eventId: ev1,
      items: [{ productId: product.id, variantId: a5.id, quantity: 2 }],
      cashReceived: 50000,
    })

    // Transaksi di Event 2: Omzet 40.000
    await service.createTransaction({
      eventId: ev2.id,
      items: [{ productId: product.id, variantId: a4.id, quantity: 1 }],
      cashReceived: 50000,
    })

    const comparison = await service.getEventComparison()
    expect(comparison.events).toHaveLength(2)
    expect(comparison.summary.totalRevenueAllEvents).toBe(90000)
    expect(comparison.summary.totalTransactionsAllEvents).toBe(2)
    expect(comparison.summary.bestRevenueEvent?.id).toBe(ev1)
    expect(comparison.summary.bestRevenueEvent?.revenue).toBe(50000)
  })

})

describe('backup tanpa kredensial', () => {
  it('ekspor tidak membawa metadata PIN dan restore dapat dilakukan tanpa autentikasi', async () => {
    const { product, a5, eventId } = await seeded(); await service.db.meta.bulkPut([{ key: 'pin:cashier', value: 'legacy' }, { key: 'pinGuard:owner', value: 'legacy' }]); await service.createTransaction({ eventId, items: [{ productId: product.id, variantId: a5.id, quantity: 1 }], cashReceived: 25000 })
    const before = await service.getBootstrap(); const backup = await service.exportBackup(); const serialized = JSON.stringify(backup)
    expect(serialized).not.toContain('pin:cashier'); expect(serialized).not.toContain('pinGuard:owner')
    const fresh = open(`${dbName}-restore`); extraServices.push(fresh); await fresh.ready(); await fresh.restoreBackup(serialized)
    expect(await fresh.getBootstrap()).toEqual(before)
  })

  it('restore pada instalasi terpakai tidak meminta PIN dan file rusak tidak menyentuh data', async () => {
    const { a5 } = await seeded(); const good = await service.exportBackup(); const tampered = structuredClone(good)
    ;(tampered.data.products[0] as { variants: { stock: number }[] }).variants[0].stock = 999
    expect(await code(service.restoreBackup(JSON.stringify(tampered)))).toBe('BACKUP_INVALID'); expect(await stockOf(a5.id)).toBe(3)
    expect(await code(service.restoreBackup(JSON.stringify(good)))).toBe('resolved')
  })

  it('auto-backup berjalan setiap ambang transaksi', async () => {
    const saved: unknown[] = []; service.close(); service = open(dbName, { autoBackupEvery: 2, autoBackup: async (backup) => { saved.push(backup) } })
    const { product, a5, eventId } = await seeded()
    await service.createTransaction({ eventId, items: [{ productId: product.id, variantId: a5.id, quantity: 1 }], cashReceived: 25000 }); expect(saved).toHaveLength(0)
    await service.createTransaction({ eventId, items: [{ productId: product.id, variantId: a5.id, quantity: 1 }], cashReceived: 25000 })
    for (let attempt = 0; attempt < 20 && saved.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(saved).toHaveLength(1)
  })
})

describe('pemisahan data demo', () => {
  it('service produksi tidak mengimpor mockData atau menyediakan loadDemoData', async () => {
    const source = await readFile(join(process.cwd(), 'src/services/localPosService.ts'), 'utf8')
    expect(source).not.toContain('mockData'); expect('loadDemoData' in service).toBe(false)
  })

  it('helper test mengisi katalog fiktif hanya saat kosong', async () => {
    await service.ready(); await seedDemoCatalog(service); const data = await service.getBootstrap()
    expect(data.products.map((p) => p.name).sort()).toEqual(initialMockData.products.map((p) => p.name).sort()); await expect(seedDemoCatalog(service)).rejects.toThrow(/katalog harus kosong/i)
  })
})

const item = (productId: string, variantId: string, quantity = 1) => ({ productId, variantId, quantity })
const tableDump = async (instance: LocalPosService) => Object.fromEntries(await Promise.all(instance.db.tables.map(async (t) => [t.name, await t.toArray()] as const)))
const tinyJpeg = (n = 8) => `data:image/jpeg;base64,${'A'.repeat(n * 4)}`

describe('arsip event: transaksi dan laporan tidak hilang', () => {
  it('event yang diarsipkan menyimpan transaksi, laporan, dan riwayat stok, tetapi menolak penjualan baru', async () => {
    const { product, a5, eventId: ev1 } = await seeded()
    const ev2 = await service.saveEvent({ name: 'Comifuro 19', venue: 'ICE BSD' })
    const sale = await service.createTransaction({ eventId: ev2.id, items: [item(product.id, a5.id)], cashReceived: 25000 })
    const reportBefore = await service.getEventReport(ev2.id)

    expect(await service.archiveEvent(ev2.id)).toEqual({ activeEventId: ev1 })
    const data = await service.getBootstrap()
    expect(data.events.map((e) => e.id)).toEqual([ev1])
    expect(data.archivedEvents).toMatchObject([{ id: ev2.id, archived: true, active: false }])
    expect(data.transactions.find((t) => t.id === sale.id)).toMatchObject({ eventId: ev2.id, status: 'completed' })
    expect(await service.getEventReport(ev2.id)).toEqual(reportBefore)
    expect((await service.getEventComparison()).events.map((e) => e.event.id)).toContain(ev2.id)

    const before = await service.db.transactions.count()
    expect(await code(service.createTransaction({ eventId: ev2.id, items: [item(product.id, a5.id)], cashReceived: 25000 }))).toBe('EVENT_ARCHIVED')
    expect(await code(service.setActiveEvent(ev2.id))).toBe('EVENT_ARCHIVED')
    expect(await service.db.transactions.count()).toBe(before)

    // A sale from an archived event can still be voided, and every movement points at a real transaction.
    await service.voidTransaction(sale.id, 'Salah input')
    expect(await stockOf(a5.id)).toBe(3)
    const txIds = new Set((await service.db.transactions.toArray()).map((t) => t.id))
    expect((await service.db.stockMovements.toArray()).every((m) => !m.transactionId || txIds.has(m.transactionId))).toBe(true)
  })

  it('event aktif tidak bisa diarsipkan tanpa pengganti yang valid', async () => {
    const { eventId: ev1 } = await seeded()
    const ev2 = await service.saveEvent({ name: 'Creator Alley' })
    const ev3 = await service.saveEvent({ name: 'Gelar Jepang' })
    expect(await failure(service.archiveEvent(ev1))).toMatchObject({ code: 'EVENT_REPLACEMENT_REQUIRED' })
    expect(await code(service.archiveEvent(ev1, { replacementEventId: ev1 }))).toBe('VALIDATION')
    expect(await code(service.archiveEvent(ev1, { replacementEventId: 'tidak-ada' }))).toBe('EVENT_NOT_FOUND')
    await service.archiveEvent(ev3.id)
    expect(await code(service.archiveEvent(ev1, { replacementEventId: ev3.id }))).toBe('EVENT_ARCHIVED')
    // Nothing above changed anything.
    expect((await service.getBootstrap()).events.find((e) => e.active)?.id).toBe(ev1)

    expect(await service.archiveEvent(ev1, { replacementEventId: ev2.id })).toEqual({ activeEventId: ev2.id })
    const data = await service.getBootstrap()
    expect(data.events).toMatchObject([{ id: ev2.id, active: true }])
    // The only live event is active and has no possible replacement, so it can never be archived.
    expect(await code(service.archiveEvent(ev2.id, { replacementEventId: ev1 }))).toBe('EVENT_ARCHIVED')
    expect(await code(service.archiveEvent(ev2.id))).toBe('EVENT_REPLACEMENT_REQUIRED')
  })

  it('deleteEvent lama kini mengarsipkan, mengembalikan event aktif baru, dan event dapat dipulihkan', async () => {
    const { product, a5, eventId: ev1 } = await seeded()
    const ev2 = await service.saveEvent({ name: 'ChibiCon 2026' })
    await service.createTransaction({ eventId: ev2.id, items: [item(product.id, a5.id)], cashReceived: 25000 })
    expect(await service.deleteEvent(ev2.id)).toBeUndefined()
    expect(await service.db.events.get(ev2.id)).toMatchObject({ archived: true })
    expect(await service.db.transactions.where('eventId').equals(ev2.id).count()).toBe(1)
    expect(await code(service.deleteEvent('tidak-ada'))).toBe('EVENT_NOT_FOUND')

    expect(await service.unarchiveEvent(ev2.id)).toMatchObject({ id: ev2.id, archived: false })
    await service.setActiveEvent(ev2.id)
    expect(await code(service.deleteEvent(ev2.id))).toBe('EVENT_REPLACEMENT_REQUIRED')
    expect(await service.deleteEvent(ev2.id, ev1)).toBe(ev1)
    // Editing an archived event keeps it archived.
    await service.saveEvent({ id: ev2.id, name: 'ChibiCon 2026 (revisi)' })
    expect(await service.db.events.get(ev2.id)).toMatchObject({ archived: true, name: 'ChibiCon 2026 (revisi)' })
  })
})

describe('arsip produk dan audit stok', () => {
  it('produk yang belum pernah dipakai dihapus permanen beserta baris stok awalnya', async () => {
    const { product } = await seeded()
    expect(await service.deleteProduct(product.id)).toEqual({ outcome: 'deleted' })
    expect(await service.db.products.get(product.id)).toBeUndefined()
    expect(await service.db.stockMovements.where('productId').equals(product.id).count()).toBe(0)
  })

  it('produk yang pernah terjual diarsipkan, snapshot transaksi tetap, dan void mengembalikan stok ke produk arsip', async () => {
    const { product, a5, eventId } = await seeded()
    const sale = await service.createTransaction({ eventId, items: [item(product.id, a5.id, 2)], cashReceived: 50000 })
    await service.saveProduct({ id: product.id, name: 'Nama Baru', categoryId: product.categoryId, variants: [{ id: a5.id, price: 99000 }, { id: product.variants[1].id, price: 40000 }] })

    expect(await service.deleteProduct(product.id)).toEqual({ outcome: 'archived' })
    const data = await service.getBootstrap()
    expect(data.products.some((p) => p.id === product.id)).toBe(false)
    expect(data.archivedProducts?.find((p) => p.id === product.id)).toMatchObject({ archived: true, name: 'Nama Baru' })
    expect(data.transactions.find((t) => t.id === sale.id)?.items[0]).toMatchObject({ productName: 'Print Cosmic', price: 25000, quantity: 2 })
    expect(await code(service.createTransaction({ eventId, items: [item(product.id, a5.id)], cashReceived: 99000 }))).toBe('STOCK_CHANGED')

    await service.voidTransaction(sale.id, 'Pembeli batal')
    const row = await service.db.products.get(product.id)
    expect(row?.variants.find((v) => v.id === a5.id)?.stock).toBe(3)
    expect(row?.archived).toBe(true)
    const voidMove = await service.db.stockMovements.where('transactionId').equals(sale.id).filter((m) => m.kind === 'void').first()
    expect(voidMove).toMatchObject({ delta: 2, stockAfter: 3, productName: 'Print Cosmic' })
  })

  it('varian yang pernah terjual lalu dihapus dari produk diarsipkan, bukan dibuang', async () => {
    const { product, a5, a4, eventId } = await seeded()
    const sale = await service.createTransaction({ eventId, items: [item(product.id, a4.id)], cashReceived: 40000 })
    await service.saveProduct({ id: product.id, name: product.name, categoryId: product.categoryId, variants: [{ id: a5.id, price: 25000 }] })
    expect((await service.getBootstrap()).products.find((p) => p.id === product.id)?.variants.map((v) => v.id)).toEqual([a5.id])
    expect((await service.db.products.get(product.id))?.variants.find((v) => v.id === a4.id)).toMatchObject({ archived: true, stock: 0 })
    expect(await code(service.createTransaction({ eventId, items: [item(product.id, a4.id)], cashReceived: 40000 }))).toBe('STOCK_CHANGED')
    await service.voidTransaction(sale.id, 'Retur')
    expect((await service.db.products.get(product.id))?.variants.find((v) => v.id === a4.id)?.stock).toBe(1)
    // A variant that was never used is simply removed.
    await service.saveProduct({ id: product.id, name: product.name, categoryId: product.categoryId, variants: [{ id: a5.id, price: 25000 }, { name: 'Baru', price: 1000, stock: 0 }] })
    const withNew = await service.db.products.get(product.id)
    const fresh = withNew!.variants.find((v) => v.name === 'Baru')!
    await service.saveProduct({ id: product.id, name: product.name, categoryId: product.categoryId, variants: [{ id: a5.id, price: 25000 }] })
    expect((await service.db.products.get(product.id))?.variants.some((v) => v.id === fresh.id)).toBe(false)
  })

  it('edit produk arsip tidak memulihkannya; pulihkan eksplisit; kategori produk arsip tidak bisa dihapus', async () => {
    const { product, a5, eventId } = await seeded()
    await service.createTransaction({ eventId, items: [item(product.id, a5.id)], cashReceived: 25000 })
    await service.archiveProduct(product.id)
    await service.saveProduct({ id: product.id, name: 'Masih Arsip', categoryId: product.categoryId, price: 1 })
    expect(await service.db.products.get(product.id)).toMatchObject({ archived: true, name: 'Masih Arsip' })
    expect(await code(service.deleteCategory(product.categoryId))).toBe('VALIDATION')
    expect(await service.unarchiveProduct(product.id)).toMatchObject({ id: product.id, name: 'Masih Arsip' })
    expect((await service.getBootstrap()).products.some((p) => p.id === product.id)).toBe(true)
  })
})

describe('promo bundle dihitung service dan tidak bisa dipalsukan', () => {
  async function withBundle() {
    const base = await seeded()
    const bundle = await service.saveBundle({ name: 'Duo', price: 55000, items: [item(base.product.id, base.a5.id), item(base.product.id, base.a4.id)] })
    const cart = [item(base.product.id, base.a5.id), item(base.product.id, base.a4.id)]
    return { ...base, bundle, cart }
  }

  it('diskon dan nama promo dari UI tidak dipercaya', async () => {
    const { eventId, bundle, cart } = await withBundle()
    expect(await failure(service.createTransaction({ eventId, items: cart, cashReceived: 65000, discount: 30000, promoName: 'Palsu' }))).toMatchObject({ code: 'PROMO_INVALID', details: { reason: 'UNTRUSTED_DISCOUNT' } })
    expect(await failure(service.createTransaction({ eventId, items: cart, cashReceived: 65000, bundleId: bundle.id, discount: 30000 }))).toMatchObject({ code: 'PROMO_INVALID', details: { reason: 'DISCOUNT_MISMATCH', expected: 10000 } })
    expect(await service.db.transactions.count()).toBe(0)
    const tx = await service.createTransaction({ eventId, items: cart, cashReceived: 55000, bundleId: bundle.id, discount: 10000, promoName: 'Palsu' })
    expect(tx).toMatchObject({ total: 55000, discount: 10000, promoName: 'Duo' })
    expect(Number.isSafeInteger(tx.total) && Number.isSafeInteger(tx.discount)).toBe(true)
  })

  it('satu promo per transaksi: bundle dipakai sekali walau keranjang berisi dua set', async () => {
    const { product, a5, a4, eventId, bundle } = await withBundle()
    await service.adjustStock(product.id, a4.id, 1, 'Restock')
    const tx = await service.createTransaction({ eventId, items: [item(product.id, a5.id, 2), item(product.id, a4.id, 2)], cashReceived: 200000, bundleId: bundle.id })
    expect(tx).toMatchObject({ subtotal: 130000, discount: 10000, total: 120000 })
  })

  it('menolak bundle yang tidak ditemukan, nonaktif, kurang kuantitas, atau isinya tidak tersedia', async () => {
    const { product, a5, a4, eventId, bundle, cart } = await withBundle()
    const reason = async (input: Partial<Parameters<typeof service.createTransaction>[0]>) => (await failure(service.createTransaction({ eventId, items: cart, cashReceived: 65000, ...input }))).details?.reason

    expect(await reason({ bundleId: 'tidak-ada' })).toBe('NOT_FOUND')
    expect(await reason({ bundleId: bundle.id, items: [item(product.id, a5.id)] })).toBe('INSUFFICIENT_QUANTITY')
    await service.toggleBundleActive(bundle.id)
    expect(await reason({ bundleId: bundle.id })).toBe('INACTIVE')
    await service.setBundleActive(bundle.id, true)

    await service.saveProduct({ id: product.id, name: product.name, categoryId: product.categoryId, variants: [{ id: a5.id, price: 25000 }, { id: a4.id, price: 20000 }] })
    expect(await reason({ bundleId: bundle.id })).toBe('NO_SAVING')
    expect(await service.getBundlePricing(bundle.id)).toMatchObject({ valid: false, reason: 'NO_SAVING' })
    await service.saveProduct({ id: product.id, name: product.name, categoryId: product.categoryId, variants: [{ id: a5.id, price: 25000 }, { id: a4.id, price: 40000 }] })
    expect(await service.getBundlePricing(bundle.id)).toEqual({ bundleId: bundle.id, valid: true, normalPrice: 65000, bundlePrice: 55000, discount: 10000 })

    // Removing a variant that a bundle uses archives it; the bundle then fails closed.
    await service.saveProduct({ id: product.id, name: product.name, categoryId: product.categoryId, variants: [{ id: a5.id, price: 25000 }] })
    expect(await reason({ bundleId: bundle.id, items: [item(product.id, a5.id)] })).toBe('VARIANT_NOT_FOUND')
    await service.archiveProduct(product.id)
    expect(await service.getBundlePricing(bundle.id)).toMatchObject({ valid: false, reason: 'PRODUCT_UNAVAILABLE' })
    expect(await service.db.transactions.count()).toBe(0)
  })

  it('menolak isi duplikat dan harga tidak valid saat simpan maupun bila data tersimpan rusak', async () => {
    const { product, a5, eventId, bundle, cart } = await withBundle()
    expect(await code(service.saveBundle({ name: 'Dobel', price: 30000, items: [item(product.id, a5.id), item(product.id, a5.id)] }))).toBe('VALIDATION')
    expect(await code(service.saveBundle({ name: 'Gratis', price: 0, items: [item(product.id, a5.id)] }))).toBe('VALIDATION')
    expect(await code(service.saveBundle({ name: 'Hantu', price: 1000, items: [item('hilang', a5.id)] }))).toBe('VALIDATION')
    expect(await code(service.saveBundle({ name: 'Varian hantu', price: 1000, items: [item(product.id, 'hilang')] }))).toBe('VALIDATION')

    await service.db.bundles.update(bundle.id, { items: [item(product.id, a5.id), item(product.id, a5.id)] })
    expect((await failure(service.createTransaction({ eventId, items: cart, cashReceived: 65000, bundleId: bundle.id }))).details?.reason).toBe('DUPLICATE_ITEM')
    await service.db.bundles.update(bundle.id, { items: cart, price: 1.5 })
    expect((await failure(service.createTransaction({ eventId, items: cart, cashReceived: 65000, bundleId: bundle.id }))).details?.reason).toBe('INVALID_PRICE')
  })
})

describe('QRIS offline wajib konfirmasi kasir', () => {
  it('memilih QRIS saja tidak dianggap lunas', async () => {
    const { product, a5, eventId } = await seeded()
    expect(await code(service.createTransaction({ eventId, items: [item(product.id, a5.id)], cashReceived: 0, paymentMethod: 'qris' }))).toBe('PAYMENT_NOT_CONFIRMED')
    expect(await code(service.createTransaction({ eventId, items: [item(product.id, a5.id)], cashReceived: 0, paymentMethod: 'qris', paymentConfirmed: 'ya' as never }))).toBe('PAYMENT_NOT_CONFIRMED')
    expect(await stockOf(a5.id)).toBe(3); expect(await service.db.transactions.count()).toBe(0)
  })

  it('referensi QRIS opsional disimpan, data sensitif ditolak, dan struk tidak mengklaim verifikasi gateway', async () => {
    const { product, a5, eventId } = await seeded()
    const qris = (paymentReference?: string) => service.createTransaction({ eventId, items: [item(product.id, a5.id)], cashReceived: 0, paymentMethod: 'qris', paymentConfirmed: true, paymentReference })
    expect(await code(qris('081234567890'))).toBe('VALIDATION')
    expect(await code(qris('4111 1111 1111 1111'))).toBe('VALIDATION')
    expect(await code(qris('x'.repeat(41)))).toBe('VALIDATION')
    expect(await code(service.createTransaction({ eventId, items: [item(product.id, a5.id)], cashReceived: 25000, paymentReference: 'ref 1234' }))).toBe('VALIDATION')
    const tx = await qris('  ref   1234 ')
    expect(tx).toMatchObject({ paymentReference: 'ref 1234', paymentStatus: 'confirmed' })
    const receipt = await service.getReceiptText(tx.id)
    expect(receipt).toContain('QRIS — dikonfirmasi kasir'); expect(receipt).toContain('ref 1234')
    expect(receipt).not.toMatch(/lunas|terverifikasi|verified/i)
    expect(receipt.split('\n').every((line) => line.length <= RECEIPT_COLUMNS)).toBe(true)
  })

  it('idempotency QRIS: retry dengan kunci sama tidak menjual dua kali', async () => {
    const { product, a5, eventId } = await seeded()
    const input = { eventId, items: [item(product.id, a5.id)], cashReceived: 25000, paymentMethod: 'qris' as const, paymentConfirmed: true, idempotencyKey: crypto.randomUUID() }
    const first = await service.createTransaction(input)
    expect((await service.createTransaction(input)).id).toBe(first.id)
    expect(await service.db.transactions.count()).toBe(1)
  })
})

describe('foto produk di tabel images', () => {
  it('foto disimpan terpisah dari baris produk, tervalidasi, dan dapat dihapus', async () => {
    const { product } = await seeded()
    const variants = product.variants.map((v) => ({ id: v.id, price: v.price }))
    expect(await code(service.saveProduct({ id: product.id, name: product.name, categoryId: product.categoryId, variants, image: 'data:image/svg+xml;base64,PHN2Zz4=' }))).toBe('IMAGE_INVALID_TYPE')
    expect(await code(service.saveProduct({ id: product.id, name: product.name, categoryId: product.categoryId, variants, image: `data:image/jpeg;base64,${'A'.repeat(300_000)}` }))).toBe('IMAGE_TOO_LARGE')
    expect(await code(service.saveSettings({ qrisImage: 'bukan-gambar' }))).toBe('IMAGE_INVALID_TYPE')

    const photo = tinyJpeg()
    const saved = await service.saveProduct({ id: product.id, name: product.name, categoryId: product.categoryId, variants, image: photo })
    expect(saved.image).toBe(photo)
    const row = await service.db.products.get(product.id)
    expect(row?.image).toBeUndefined(); expect(row?.imageId).toBeTruthy()
    expect(await service.db.images.get(row!.imageId!)).toMatchObject({ dataUrl: photo, mime: 'image/jpeg' })
    expect((await service.getBootstrap()).products[0]).toMatchObject({ image: photo, imageId: row!.imageId })

    // Re-saving the same photo keeps the same reference; removing it deletes the row.
    await service.saveProduct({ id: product.id, name: 'Ganti nama', categoryId: product.categoryId, variants, image: photo })
    expect((await service.db.products.get(product.id))?.imageId).toBe(row!.imageId)
    await service.saveProduct({ id: product.id, name: 'Ganti nama', categoryId: product.categoryId, variants, image: '' })
    expect(await service.db.images.count()).toBe(0)
  })
})

describe('backup/restore v2 identik', () => {
  it('restore ke instalasi baru menghasilkan isi tabel yang identik, termasuk foto, bundle, dan event arsip', async () => {
    const { product, a5, a4, eventId } = await seeded()
    await service.saveProduct({ id: product.id, name: product.name, categoryId: product.categoryId, variants: [{ id: a5.id, price: 25000 }, { id: a4.id, price: 40000 }], image: tinyJpeg() })
    const bundle = await service.saveBundle({ name: 'Duo', price: 55000, items: [item(product.id, a5.id), item(product.id, a4.id)] })
    await service.createTransaction({ eventId, items: [item(product.id, a5.id), item(product.id, a4.id)], cashReceived: 55000, bundleId: bundle.id })
    const ev2 = await service.saveEvent({ name: 'Lama' })
    await service.createTransaction({ eventId: ev2.id, items: [item(product.id, a5.id)], cashReceived: 0, paymentMethod: 'qris', paymentConfirmed: true, paymentReference: 'ref 99' })
    await service.archiveEvent(ev2.id)

    const backup = await service.exportBackup()
    expect(backup.schemaVersion).toBe(2)
    expect(backup.counts).toMatchObject({ images: 1, bundles: 1, transactions: 2 })
    const fresh = open(`${dbName}-restore`); extraServices.push(fresh); await fresh.ready()
    const result = await fresh.restoreBackup(JSON.stringify(backup))
    expect(result.upgradedFrom).toBeUndefined()
    expect(await tableDump(fresh)).toEqual(await tableDump(service))
    expect(await fresh.getBootstrap()).toEqual(await service.getBootstrap())
  })

  it('menolak backup v2 dengan riwayat stok yatim atau semua event diarsipkan', async () => {
    const { product, a5, eventId } = await seeded()
    await service.createTransaction({ eventId, items: [item(product.id, a5.id)], cashReceived: 25000 })
    const reseal = async (mutate: (b: Awaited<ReturnType<typeof service.exportBackup>>) => void) => {
      const b = structuredClone(await service.exportBackup()); mutate(b)
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(b.data)))
      b.checksum = Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('')
      return JSON.stringify(b)
    }
    const orphan = await reseal((b) => { b.data.transactions = []; b.counts.transactions = 0 })
    expect((await failure(service.restoreBackup(orphan))).message).toMatch(/riwayat stok merujuk transaksi/)
    const allArchived = await reseal((b) => { for (const e of b.data.events as { archived: boolean }[]) e.archived = true })
    expect((await failure(service.restoreBackup(allArchived))).message).toMatch(/tidak ada event yang aktif/)
    expect(await service.db.transactions.count()).toBe(1)
  })
})
