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
    // Transaksi 1: Tunai Rp 25.000
    const txCash = await service.createTransaction({
      eventId,
      items: [{ productId: product.id, variantId: a5.id, quantity: 1 }],
      cashReceived: 30000,
      paymentMethod: 'cash',
    })
    expect(txCash.paymentMethod).toBe('cash')
    expect(txCash.change).toBe(5000)

    // Transaksi 2: QRIS Rp 25.000
    const txQris = await service.createTransaction({
      eventId,
      items: [{ productId: product.id, variantId: a5.id, quantity: 1 }],
      cashReceived: 0,
      paymentMethod: 'qris',
    })
    expect(txQris.paymentMethod).toBe('qris')
    expect(txQris.cashReceived).toBe(25000)
    expect(txQris.change).toBe(0)

    // Periksa struk QRIS
    const qrisReceipt = await service.getReceiptText(txQris.id)
    expect(qrisReceipt).toContain('QRIS')

    // Periksa pemisahan omzet di laporan
    const report = await service.getEventReport(eventId)
    expect(report.revenue).toBe(50000)
    expect(report.cashRevenue).toBe(25000)
    expect(report.qrisRevenue).toBe(25000)
    expect(report.transactionCount).toBe(2)
  })

  it('mendukung edit produk dan mencatat riwayat penyesuaian stok saat diedit', async () => {
    const { product, a5 } = await seeded()
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

  it('mendukung checkout dengan diskon promo bundle dan struk mencatat diskon', async () => {
    const { product, a5, a4, eventId } = await seeded()
    // Checkout 1x A5 (25.000) + 1x A4 (40.000) = Subtotal 65.000, diskon 10.000 -> Total 55.000
    const tx = await service.createTransaction({
      eventId,
      items: [
        { productId: product.id, variantId: a5.id, quantity: 1 },
        { productId: product.id, variantId: a4.id, quantity: 1 },
      ],
      cashReceived: 60000,
      discount: 10000,
      promoName: 'Paket Cosmic Double',
    })

    expect(tx.subtotal).toBe(65000)
    expect(tx.discount).toBe(10000)
    expect(tx.total).toBe(55000)
    expect(tx.change).toBe(5000)
    expect(tx.promoName).toBe('Paket Cosmic Double')

    // Struk harus mencantumkan subtotal dan diskon
    const receipt = await service.getReceiptText(tx.id)
    expect(receipt).toContain('Subtotal')
    expect(receipt).toContain('Diskon')
    expect(receipt).toContain('-Rp 10.000')
    expect(receipt).toContain('TOTAL')
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
