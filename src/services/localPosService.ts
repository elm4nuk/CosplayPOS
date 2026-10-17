import { createBackup, parseBackup, restoreBackup, type BackupFile } from '../storage/backup'
import { PosDatabase, type CategoryRow, type EventRow, type ProductRow, type StockMovementRow, type TransactionRow, type VariantRow } from '../storage/db'
import { PosError } from '../storage/errors'
import { formatReceiptText } from '../storage/receipt'
import type { BootstrapData, Product, PromoBundle, PromoBundleItem, Transaction } from '../types'
import type { PosService } from './posService'

export type ShopSettings = { shopName: string; footer: string; receiptPrefix: string; defaultCashier: string; qrisImage?: string }
export type ReadyState = { firstRun: boolean }

export type CheckoutInput = {
  eventId: string
  /** Only ids and quantities are trusted; price and name come from the database. */
  items: { productId: string; variantId: string; quantity: number }[]
  cashReceived: number
  paymentMethod?: 'cash' | 'qris'
  /** One key per checkout attempt. Retrying with the same key never sells twice. */
  idempotencyKey?: string
  discount?: number
  promoName?: string
}

export type SaveProductInput = {
  id?: string
  name: string
  categoryId: string
  description?: string
  accent?: string
  image?: string
  featured?: boolean
  variants?: { id?: string; name?: string; price: number; sku?: string; stock?: number }[]
  price?: number
  stock?: number
}

export type EventReport = {
  eventId: string
  revenue: number
  cashRevenue: number
  qrisRevenue: number
  transactionCount: number
  itemsSold: number
  averageTicket: number
  voidCount: number
  byHour: { hour: number; revenue: number; transactions: number }[]
  topProducts: { productId: string; productName: string; quantity: number; revenue: number }[]
}

export type EventComparisonItem = {
  event: EventRow
  report: EventReport
  growthPercent?: number
}

export type EventComparisonReport = {
  events: EventComparisonItem[]
  summary: {
    totalRevenueAllEvents: number
    totalTransactionsAllEvents: number
    bestRevenueEvent: { id: string; name: string; revenue: number } | null
    bestTransactionsEvent: { id: string; name: string; count: number } | null
    highestTicketEvent: { id: string; name: string; averageTicket: number } | null
    overallTopProducts: { productId: string; productName: string; quantity: number; revenue: number }[]
  }
}

export type LocalServiceOptions = {
  dbName?: string
  now?: () => Date
  /** Called with a fresh snapshot every `autoBackupEvery` sales. Failures are logged, never thrown. */
  autoBackup?: (backup: BackupFile) => Promise<void>
  autoBackupEvery?: number
}

const DEFAULT_SETTINGS: ShopSettings = { shopName: 'CosplayPOS', footer: 'Terima kasih sudah mampir!', receiptPrefix: 'TRX', defaultCashier: 'Kasir' }
/** UI pseudo-category kept for compatibility with the current App filter row. */
const ALL_CATEGORY = { id: 'all', name: 'Semua', color: '#18181b' }

const fail = (code: ConstructorParameters<typeof PosError>[0], message: string, details?: Record<string, unknown>): never => { throw new PosError(code, message, details) }
const text = (value: unknown, label: string) => (typeof value === 'string' && value.trim() ? value.trim() : fail('VALIDATION', `${label} wajib diisi.`))
const rupiah = (value: unknown, label: string) => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : fail('VALIDATION', `${label} harus bilangan bulat rupiah ≥ 0.`))
const uuid = () => crypto.randomUUID()

export function createLocalPosService(options: LocalServiceOptions = {}) {
  const db = new PosDatabase(options.dbName)
  const now = options.now ?? (() => new Date())
  const autoBackupEvery = options.autoBackupEvery ?? 10
  let readyPromise: Promise<ReadyState> | null = null

  const settings = async () => ({ ...DEFAULT_SETTINGS, ...((await db.meta.get('settings'))?.value as Partial<ShopSettings> | undefined) })
  const activeEventId = async () => (await db.meta.get('activeEventId'))?.value as string | undefined

  async function init(): Promise<ReadyState> {
    await navigator.storage?.persist?.().catch(() => false)
    const firstRun = await db.transaction('rw', db.meta, db.events, async () => {
      if (await db.meta.get('createdAt')) return false
      const event: EventRow = { id: uuid(), name: 'Event pertama', venue: '', dateLabel: now().toLocaleDateString('id-ID', { dateStyle: 'medium' }), createdAt: now().toISOString() }
      await db.events.add(event)
      await db.meta.bulkPut([{ key: 'createdAt', value: now().toISOString() }, { key: 'activeEventId', value: event.id }, { key: 'txSeq', value: 0 }])
      return true
    })
    const obsoleteSecurityRows = (await db.meta.toArray()).map((row) => row.key).filter((key) => key.startsWith('pin:') || key.startsWith('pinGuard:'))
    if (obsoleteSecurityRows.length) await db.meta.bulkDelete(obsoleteSecurityRows)
    return { firstRun }
  }

  const ready = () => (readyPromise ??= init())

  const toProduct = (row: ProductRow): Product => ({ id: row.id, name: row.name, categoryId: row.categoryId, description: row.description, accent: row.accent, image: row.image, featured: row.featured, variants: row.variants.map((v) => ({ ...v })) })

  const toTransaction = (row: TransactionRow, stockOf: Map<string, number>): Transaction => ({
    id: row.id, number: row.number, eventId: row.eventId, createdAt: row.createdAt, cashierName: row.cashierName,
    items: row.items.map((item) => ({ productId: item.productId, productName: item.productName, variantId: item.variantId, variantName: item.variantName, price: item.price, quantity: item.quantity, stock: stockOf.get(item.variantId) ?? 0 })),
    subtotal: row.subtotal ?? row.total, discount: row.discount ?? 0, promoName: row.promoName,
    total: row.total, cashReceived: row.cashReceived, change: row.change, paymentMethod: row.paymentMethod ?? 'cash', status: row.status, voidedAt: row.voidedAt, voidReason: row.voidReason,
  })

  const stockMap = (products: ProductRow[]) => new Map(products.flatMap((p) => p.variants.map((v) => [v.id, v.stock] as const)))

  const checkoutSignature = (eventId: string, items: { variantId: string; quantity: number }[], cash: number, method = 'cash', discount = 0) =>
    `${eventId}|${method}|${cash}|${discount}|${items.map((i) => `${i.variantId}:${i.quantity}`).sort().join(',')}`

  async function maybeAutoBackup(seq: number) {
    if (!options.autoBackup || seq % autoBackupEvery !== 0) return
    try { await options.autoBackup(await createBackup(db, now())) } catch (reason) { console.warn('Auto-backup gagal', reason) }
  }

  const service = {
    db,
    ready,

    async getSettings() { await ready(); return settings() },
    async saveSettings(next: Partial<ShopSettings>) {
      await ready()
      const current = await settings()
      const merged = { ...current, ...next }
      text(merged.shopName, 'Nama booth'); text(merged.receiptPrefix, 'Prefix nomor struk')
      await db.meta.put({ key: 'settings', value: merged })
      return merged
    },

    async getBootstrap(): Promise<BootstrapData> {
      await ready()
      return db.transaction('r', [db.meta, db.categories, db.products, db.events, db.transactions, db.stockMovements], async () => {
        const [categories, products, events, transactions, movements, activeId, bundleMeta] = await Promise.all([
          db.categories.orderBy('sortOrder').toArray(), db.products.toArray(), db.events.orderBy('createdAt').toArray(),
          db.transactions.orderBy('seq').reverse().toArray(), db.stockMovements.orderBy('createdAt').reverse().filter((m) => m.kind !== 'sale').limit(100).toArray(), activeEventId(),
          db.meta.get('bundles'),
        ])
        const stockOf = stockMap(products)
        const bundles = (bundleMeta?.value as PromoBundle[] | undefined) ?? []
        return {
          categories: [ALL_CATEGORY, ...categories.map(({ id, name, color }) => ({ id, name, color }))],
          products: products.filter((p) => !p.archived).map(toProduct),
          events: events.map((e) => ({ id: e.id, name: e.name, venue: e.venue, dateLabel: e.dateLabel, active: e.id === activeId })),
          transactions: transactions.map((t) => toTransaction(t, stockOf)),
          stockAdjustments: movements.map((m) => ({ id: m.id, productName: m.productName, variantName: m.variantName, delta: m.delta, reason: m.reason, createdAt: m.createdAt, actor: m.actor })),
          bundles,
        }
      })
    },

    async createTransaction(input: CheckoutInput): Promise<Transaction> {
      await ready()
      const actor = (await settings()).defaultCashier
      const isQris = input.paymentMethod === 'qris'
      const cash = isQris ? 0 : rupiah(input.cashReceived, 'Uang diterima')
      const merged = new Map<string, { productId: string; variantId: string; quantity: number }>()
      for (const item of input.items) {
        if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) fail('VALIDATION', 'Jumlah barang tidak valid.')
        const prev = merged.get(item.variantId)
        merged.set(item.variantId, { productId: item.productId, variantId: item.variantId, quantity: (prev?.quantity ?? 0) + item.quantity })
      }
      const lines = [...merged.values()]
      if (!lines.length) fail('EMPTY_CART', 'Keranjang masih kosong.')
      const signature = checkoutSignature(input.eventId, lines, cash, isQris ? 'qris' : 'cash', input.discount ?? 0)
      const prefix = (await settings()).receiptPrefix

      const row = await db.transaction('rw', [db.meta, db.events, db.products, db.transactions, db.stockMovements], async () => {
        if (input.idempotencyKey) {
          const existing = await db.transactions.get(input.idempotencyKey)
          if (existing) {
            if (checkoutSignature(existing.eventId, existing.items, existing.cashReceived, existing.paymentMethod ?? 'cash', existing.discount ?? 0) !== signature) fail('IDEMPOTENCY_CONFLICT', 'Kunci transaksi sudah dipakai untuk pesanan lain.')
            return { tx: existing, replay: true }
          }
        }
        if (!(await db.events.get(input.eventId))) fail('EVENT_NOT_FOUND', 'Event tidak ditemukan. Pilih event aktif lagi.')

        const productIds = [...new Set(lines.map((l) => l.productId))]
        const products = new Map((await db.products.bulkGet(productIds)).filter((p): p is ProductRow => Boolean(p)).map((p) => [p.id, structuredClone(p)]))
        const shortages: { variantId: string; requested: number; available: number }[] = []
        const items = lines.map((line) => {
          const product = products.get(line.productId)
          const variant = product?.variants.find((v) => v.id === line.variantId)
          if (!product || !variant || product.archived) { shortages.push({ variantId: line.variantId, requested: line.quantity, available: 0 }); return null }
          if (variant.stock < line.quantity) shortages.push({ variantId: line.variantId, requested: line.quantity, available: variant.stock })
          return { product, variant, line }
        })
        if (shortages.length) fail('STOCK_CHANGED', 'Stok baru saja berubah. Periksa keranjang.', { shortages })

        const timestamp = now().toISOString()
        const valid = items as { product: ProductRow; variant: VariantRow; line: (typeof lines)[number] }[]
        const subtotal = valid.reduce((sum, { variant, line }) => sum + variant.price * line.quantity, 0)
        const discount = Math.max(0, Math.min(subtotal, input.discount ?? 0))
        const total = subtotal - discount
        if (!Number.isSafeInteger(total)) fail('VALIDATION', 'Total terlalu besar.')
        const actualCash = isQris ? total : cash
        if (!isQris && cash < total) fail('INSUFFICIENT_CASH', 'Uang diterima masih kurang.', { total, cashReceived: cash })

        const seq = (((await db.meta.get('txSeq'))?.value as number | undefined) ?? 0) + 1
        const id = input.idempotencyKey ?? uuid()
        const movements: StockMovementRow[] = valid.map(({ product, variant, line }) => {
          variant.stock -= line.quantity
          return { id: uuid(), kind: 'sale', productId: product.id, variantId: variant.id, productName: product.name, variantName: variant.name, delta: -line.quantity, stockAfter: variant.stock, reason: 'Penjualan', actor, createdAt: timestamp, transactionId: id }
        })
        const tx: TransactionRow = {
          id, seq, number: `${prefix}-${String(seq).padStart(4, '0')}`, eventId: input.eventId, createdAt: timestamp, cashierName: actor,
          items: valid.map(({ product, variant, line }) => ({ productId: product.id, productName: product.name, variantId: variant.id, variantName: variant.name, sku: variant.sku, price: variant.price, quantity: line.quantity })),
          subtotal, discount, promoName: input.promoName,
          total, cashReceived: actualCash, change: actualCash - total, paymentMethod: isQris ? 'qris' : 'cash', status: 'completed',
        }
        await db.products.bulkPut([...products.values()].map((p) => ({ ...p, updatedAt: timestamp })))
        await db.stockMovements.bulkAdd(movements)
        await db.transactions.add(tx)
        await db.meta.put({ key: 'txSeq', value: seq })
        return { tx, replay: false }
      })

      if (!row.replay) void maybeAutoBackup(row.tx.seq)
      const current = stockMap(await db.products.bulkGet(row.tx.items.map((i) => i.productId)).then((ps) => ps.filter((p): p is ProductRow => Boolean(p))))
      return toTransaction(row.tx, current)
    },

    /** Marks a sale void, stores its reason, and returns its items to stock atomically. */
    async voidTransaction(transactionId: string, reason: string) {
      await ready()
      const actor = (await settings()).defaultCashier
      const why = text(reason, 'Alasan pembatalan')
      return db.transaction('rw', [db.products, db.transactions, db.stockMovements], async () => {
        const tx = (await db.transactions.get(transactionId)) ?? fail('NOT_FOUND', 'Transaksi tidak ditemukan.')
        if (tx.status === 'void') fail('ALREADY_VOID', 'Transaksi ini sudah dibatalkan.')
        const timestamp = now().toISOString()
        const products = new Map((await db.products.bulkGet([...new Set(tx.items.map((i) => i.productId))])).filter((p): p is ProductRow => Boolean(p)).map((p) => [p.id, p]))
        const movements: StockMovementRow[] = []
        for (const item of tx.items) {
          // A variant deleted since the sale cannot take stock back; the void is still recorded.
          const variant = products.get(item.productId)?.variants.find((v) => v.id === item.variantId)
          if (!variant) continue
          variant.stock += item.quantity
          movements.push({ id: uuid(), kind: 'void', productId: item.productId, variantId: item.variantId, productName: item.productName, variantName: item.variantName, delta: item.quantity, stockAfter: variant.stock, reason: `Batal ${tx.number}: ${why}`, actor, createdAt: timestamp, transactionId: tx.id })
        }
        await db.products.bulkPut([...products.values()].map((p) => ({ ...p, updatedAt: timestamp })))
        await db.stockMovements.bulkAdd(movements)
        const voided: TransactionRow = { ...tx, status: 'void', voidedAt: timestamp, voidReason: why }
        await db.transactions.put(voided)
        return toTransaction(voided, stockMap([...products.values()]))
      })
    },

    async adjustStock(productId: string, variantId: string, delta: number, reason: string) {
      await ready()
      const actor = (await settings()).defaultCashier
      const why = text(reason, 'Alasan penyesuaian')
      if (!Number.isSafeInteger(delta) || delta === 0) fail('VALIDATION', 'Perubahan stok harus bilangan bulat selain 0.')
      return db.transaction('rw', db.products, db.stockMovements, async () => {
        const product = (await db.products.get(productId)) ?? fail('NOT_FOUND', 'Produk tidak ditemukan.')
        const variant = product.variants.find((v) => v.id === variantId) ?? fail('NOT_FOUND', 'Varian tidak ditemukan.')
        if (variant.stock + delta < 0) fail('VALIDATION', `Stok tidak boleh minus (sisa ${variant.stock}).`)
        variant.stock += delta
        const timestamp = now().toISOString()
        await db.products.put({ ...product, updatedAt: timestamp })
        await db.stockMovements.add({ id: uuid(), kind: 'adjustment', productId, variantId, productName: product.name, variantName: variant.name, delta, stockAfter: variant.stock, reason: why, actor, createdAt: timestamp })
        return variant.stock
      })
    },

    async saveCategory(input: { id?: string; name: string; color?: string }) {
      await ready()
      const name = text(input.name, 'Nama kategori')
      return db.transaction('rw', db.categories, async () => {
        const existing = input.id ? await db.categories.get(input.id) : undefined
        const row: CategoryRow = { id: existing?.id ?? uuid(), name, color: input.color ?? existing?.color ?? '#f472b6', sortOrder: existing?.sortOrder ?? (await db.categories.count()) }
        await db.categories.put(row)
        return row
      })
    },
    async deleteCategory(id: string) {
      await ready()
      await db.transaction('rw', db.categories, db.products, async () => {
        if (await db.products.where('categoryId').equals(id).filter((p) => !p.archived).count()) fail('VALIDATION', 'Kategori masih dipakai produk aktif.')
        await db.categories.delete(id)
      })
    },

    async saveProduct(input: SaveProductInput) {
      await ready()
      const actor = (await settings()).defaultCashier
      const name = text(input.name, 'Nama produk')
      const rawVariants = input.variants && input.variants.length > 0
        ? input.variants
        : [{ name: 'Default', price: input.price ?? 0, stock: input.stock }]
      return db.transaction('rw', db.categories, db.products, db.stockMovements, async () => {
        if (!(await db.categories.get(input.categoryId))) fail('VALIDATION', 'Pilih kategori yang ada.')
        const existing = input.id ? await db.products.get(input.id) : undefined
        if (input.id && !existing) fail('NOT_FOUND', 'Produk tidak ditemukan.')
        const timestamp = now().toISOString()
        const movements: StockMovementRow[] = []
        const productId = existing?.id ?? uuid()
        const variants = rawVariants.map((v, index): VariantRow => {
          const old = v.id
            ? existing?.variants.find((o) => o.id === v.id)
            : (existing?.variants[index] ?? (existing?.variants.length === 1 ? existing.variants[0] : undefined))
          const variantId = old?.id ?? v.id ?? uuid()
          const variantName = v.name?.trim() ? v.name.trim() : (old?.name ?? 'Default')
          const variantPrice = rupiah(v.price, 'Harga')
          const variantSku = v.sku?.trim() ?? old?.sku ?? ''
          let stock = old ? old.stock : 0
          if (old) {
            if (v.stock !== undefined) {
              const newStock = rupiah(v.stock, 'Stok')
              const delta = newStock - old.stock
              if (delta !== 0) {
                movements.push({ id: uuid(), kind: 'adjustment', productId, variantId, productName: name, variantName, delta, stockAfter: newStock, reason: 'Penyesuaian saat edit produk', actor, createdAt: timestamp })
                stock = newStock
              }
            }
          } else {
            stock = v.stock === undefined ? 0 : rupiah(v.stock, 'Stok awal')
            if (stock > 0) {
              movements.push({ id: uuid(), kind: 'initial', productId, variantId, productName: name, variantName, delta: stock, stockAfter: stock, reason: 'Stok awal', actor, createdAt: timestamp })
            }
          }
          return { id: variantId, name: variantName, price: variantPrice, sku: variantSku, stock }
        })
        const row: ProductRow = {
          id: productId, name, categoryId: input.categoryId, description: input.description?.trim() ?? existing?.description ?? '',
          accent: input.accent ?? existing?.accent ?? '#ffd6e7', image: input.image !== undefined ? (input.image || undefined) : existing?.image,
          featured: input.featured ?? existing?.featured ?? false, archived: false,
          variants, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp,
        }
        await db.products.put(row)
        if (movements.length) await db.stockMovements.bulkAdd(movements)
        return toProduct(row)
      })
    },
    async deleteProduct(id: string) {
      await ready()
      return db.transaction('rw', db.products, async () => {
        const product = await db.products.get(id)
        if (!product) fail('NOT_FOUND', 'Produk tidak ditemukan.')
        await db.products.delete(id)
      })
    },
    async archiveProduct(id: string) {
      await ready()
      const updated = await db.products.update(id, { archived: true, updatedAt: now().toISOString() })
      if (!updated) fail('NOT_FOUND', 'Produk tidak ditemukan.')
    },

    async saveEvent(input: { id?: string; name: string; venue?: string; dateLabel?: string }) {
      await ready()
      const row: EventRow = { id: input.id ?? uuid(), name: text(input.name, 'Nama event'), venue: input.venue?.trim() ?? '', dateLabel: input.dateLabel?.trim() ?? '', createdAt: (input.id && (await db.events.get(input.id))?.createdAt) || now().toISOString() }
      await db.events.put(row)
      return row
    },
    async setActiveEvent(id: string) {
      await ready()
      await db.transaction('rw', db.meta, db.events, async () => {
        if (!(await db.events.get(id))) fail('EVENT_NOT_FOUND', 'Event tidak ditemukan.')
        await db.meta.put({ key: 'activeEventId', value: id })
      })
    },

    async getEventReport(eventId: string): Promise<EventReport> {
      await ready()
      const all = await db.transactions.where('eventId').equals(eventId).toArray()
      const done = all.filter((t) => t.status === 'completed')
      const hours = new Map<number, { hour: number; revenue: number; transactions: number }>()
      const top = new Map<string, EventReport['topProducts'][number]>()
      for (const t of done) {
        const hour = new Date(t.createdAt).getHours()
        const bucket = hours.get(hour) ?? { hour, revenue: 0, transactions: 0 }
        bucket.revenue += t.total; bucket.transactions += 1; hours.set(hour, bucket)
        for (const item of t.items) {
          const entry = top.get(item.productId) ?? { productId: item.productId, productName: item.productName, quantity: 0, revenue: 0 }
          entry.quantity += item.quantity; entry.revenue += item.price * item.quantity; top.set(item.productId, entry)
        }
      }
      const revenue = done.reduce((sum, t) => sum + t.total, 0)
      const cashRevenue = done.filter((t) => t.paymentMethod !== 'qris').reduce((sum, t) => sum + t.total, 0)
      const qrisRevenue = done.filter((t) => t.paymentMethod === 'qris').reduce((sum, t) => sum + t.total, 0)
      return {
        eventId, revenue, cashRevenue, qrisRevenue, transactionCount: done.length, voidCount: all.length - done.length,
        itemsSold: done.reduce((sum, t) => sum + t.items.reduce((n, i) => n + i.quantity, 0), 0),
        averageTicket: done.length ? Math.round(revenue / done.length) : 0,
        byHour: [...hours.values()].sort((a, b) => a.hour - b.hour),
        topProducts: [...top.values()].sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue).slice(0, 10),
      }
    },

    async getBundles(): Promise<PromoBundle[]> {
      await ready()
      return ((await db.meta.get('bundles'))?.value as PromoBundle[] | undefined) ?? []
    },

    async saveBundle(input: { id?: string; name: string; description?: string; price: number; items: PromoBundleItem[]; active?: boolean }): Promise<PromoBundle> {
      await ready()
      const name = text(input.name, 'Nama bundle')
      const bundlePrice = rupiah(input.price, 'Harga bundle')
      if (!input.items || !input.items.length) fail('VALIDATION', 'Bundle harus berisi minimal 1 item.')
      for (const item of input.items) {
        if (!item.productId || !item.variantId) fail('VALIDATION', 'Produk dan varian dalam bundle wajib dipilih.')
        if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) fail('VALIDATION', 'Jumlah item bundle harus >= 1.')
      }
      const current = await service.getBundles()
      const bundleId = input.id ?? uuid()
      const updated: PromoBundle = {
        id: bundleId,
        name,
        description: input.description?.trim() ?? '',
        price: bundlePrice,
        items: input.items,
        active: input.active ?? true,
      }
      const next = current.some((b) => b.id === bundleId)
        ? current.map((b) => (b.id === bundleId ? updated : b))
        : [...current, updated]
      await db.meta.put({ key: 'bundles', value: next })
      return updated
    },

    async deleteBundle(id: string): Promise<void> {
      await ready()
      const current = await service.getBundles()
      const next = current.filter((b) => b.id !== id)
      await db.meta.put({ key: 'bundles', value: next })
    },

    async toggleBundleActive(id: string): Promise<void> {
      await ready()
      const current = await service.getBundles()
      const next = current.map((b) => (b.id === id ? { ...b, active: !b.active } : b))
      await db.meta.put({ key: 'bundles', value: next })
    },

    async getEventComparison(): Promise<EventComparisonReport> {
      await ready()
      const events = await db.events.orderBy('createdAt').toArray()
      const comparisonItems: EventComparisonItem[] = []
      let prevRevenue: number | null = null

      for (const event of events) {
        const report = await service.getEventReport(event.id)
        let growthPercent: number | undefined = undefined
        if (prevRevenue !== null && prevRevenue > 0) {
          growthPercent = Math.round(((report.revenue - prevRevenue) / prevRevenue) * 100)
        }
        comparisonItems.push({ event, report, growthPercent })
        prevRevenue = report.revenue
      }

      const totalRevenue = comparisonItems.reduce((sum, item) => sum + item.report.revenue, 0)
      const totalTransactions = comparisonItems.reduce((sum, item) => sum + item.report.transactionCount, 0)
      const sortedByRevenue = [...comparisonItems].sort((a, b) => b.report.revenue - a.report.revenue)
      const sortedByTransactions = [...comparisonItems].sort((a, b) => b.report.transactionCount - a.report.transactionCount)
      const sortedByTicket = [...comparisonItems].sort((a, b) => b.report.averageTicket - a.report.averageTicket)

      const productAgg = new Map<string, { productId: string; productName: string; quantity: number; revenue: number }>()
      for (const item of comparisonItems) {
        for (const prod of item.report.topProducts) {
          const existing = productAgg.get(prod.productId) ?? { productId: prod.productId, productName: prod.productName, quantity: 0, revenue: 0 }
          existing.quantity += prod.quantity
          existing.revenue += prod.revenue
          productAgg.set(prod.productId, existing)
        }
      }

      return {
        events: comparisonItems,
        summary: {
          totalRevenueAllEvents: totalRevenue,
          totalTransactionsAllEvents: totalTransactions,
          bestRevenueEvent: sortedByRevenue[0] && sortedByRevenue[0].report.revenue > 0 ? { id: sortedByRevenue[0].event.id, name: sortedByRevenue[0].event.name, revenue: sortedByRevenue[0].report.revenue } : null,
          bestTransactionsEvent: sortedByTransactions[0] && sortedByTransactions[0].report.transactionCount > 0 ? { id: sortedByTransactions[0].event.id, name: sortedByTransactions[0].event.name, count: sortedByTransactions[0].report.transactionCount } : null,
          highestTicketEvent: sortedByTicket[0] && sortedByTicket[0].report.averageTicket > 0 ? { id: sortedByTicket[0].event.id, name: sortedByTicket[0].event.name, averageTicket: sortedByTicket[0].report.averageTicket } : null,
          overallTopProducts: [...productAgg.values()].sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue).slice(0, 5),
        },
      }
    },

    async getReceiptText(transactionId: string) {
      await ready()
      const tx = (await db.transactions.get(transactionId)) ?? fail('NOT_FOUND', 'Transaksi tidak ditemukan.')
      return formatReceiptText(toTransaction(tx, new Map()), await settings())
    },

    async exportBackup() { await ready(); return createBackup(db, now()) },
    /**
     * Validates the file completely, then replaces all data atomically. Returns a
     * safety snapshot of the data that was overwritten so the UI can offer to save it.
     */
    async restoreBackup(fileText: string) {
      await ready()
      const backup = await parseBackup(fileText)
      const previous = await createBackup(db, now())
      await restoreBackup(db, backup)
      readyPromise = null
      return { restored: backup.counts, previous }
    },

    close() { db.close() },
  } satisfies PosService & Record<string, unknown>

  return service
}

export type LocalPosService = ReturnType<typeof createLocalPosService>
