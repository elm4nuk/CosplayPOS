import { createBackup, parseBackup, restoreBackup, type BackupFile } from '../storage/backup'
import { PosDatabase, type CategoryRow, type EventRow, type ProductRow, type StockMovementRow, type TransactionRow, type VariantRow } from '../storage/db'
import { PosError } from '../storage/errors'
import { formatReceiptText } from '../storage/receipt'
import type { BootstrapData, Product, Transaction } from '../types'
import type { PosService } from './posService'

export type ShopSettings = { shopName: string; footer: string; receiptPrefix: string; defaultCashier: string }
export type ReadyState = { firstRun: boolean }

export type CheckoutInput = {
  eventId: string
  /** Only ids and quantities are trusted; price and name come from the database. */
  items: { productId: string; variantId: string; quantity: number }[]
  cashReceived: number
  /** One key per checkout attempt. Retrying with the same key never sells twice. */
  idempotencyKey?: string
}

export type SaveProductInput = {
  id?: string
  name: string
  categoryId: string
  description?: string
  accent?: string
  featured?: boolean
  /** `stock` is only used for NEW variants. Existing stock changes go through adjustStock(). */
  variants: { id?: string; name: string; price: number; sku?: string; stock?: number }[]
}

export type EventReport = {
  eventId: string
  revenue: number
  transactionCount: number
  itemsSold: number
  averageTicket: number
  voidCount: number
  byHour: { hour: number; revenue: number; transactions: number }[]
  topProducts: { productId: string; productName: string; quantity: number; revenue: number }[]
  topCategories: { categoryId: string; categoryName: string; quantity: number; revenue: number }[]
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

  const toProduct = (row: ProductRow): Product => ({ id: row.id, name: row.name, categoryId: row.categoryId, description: row.description, accent: row.accent, featured: row.featured, variants: row.variants.map((v) => ({ ...v })) })

  const toTransaction = (row: TransactionRow, stockOf: Map<string, number>): Transaction => ({
    id: row.id, number: row.number, eventId: row.eventId, createdAt: row.createdAt, cashierName: row.cashierName,
    items: row.items.map((item) => ({ productId: item.productId, productName: item.productName, variantId: item.variantId, variantName: item.variantName, price: item.price, quantity: item.quantity, stock: stockOf.get(item.variantId) ?? 0 })),
    total: row.total, cashReceived: row.cashReceived, change: row.change, status: row.status, voidedAt: row.voidedAt, voidReason: row.voidReason,
  })

  const stockMap = (products: ProductRow[]) => new Map(products.flatMap((p) => p.variants.map((v) => [v.id, v.stock] as const)))

  const checkoutSignature = (eventId: string, items: { variantId: string; quantity: number }[], cash: number) =>
    `${eventId}|${cash}|${items.map((i) => `${i.variantId}:${i.quantity}`).sort().join(',')}`

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
        const [categories, products, events, transactions, movements, activeId] = await Promise.all([
          db.categories.orderBy('sortOrder').toArray(), db.products.toArray(), db.events.orderBy('createdAt').toArray(),
          db.transactions.orderBy('seq').reverse().toArray(), db.stockMovements.orderBy('createdAt').reverse().filter((m) => m.kind !== 'sale').limit(100).toArray(), activeEventId(),
        ])
        const stockOf = stockMap(products)
        return {
          categories: [ALL_CATEGORY, ...categories.map(({ id, name, color }) => ({ id, name, color }))],
          products: products.filter((p) => !p.archived).map(toProduct),
          events: events.map((e) => ({ id: e.id, name: e.name, venue: e.venue, dateLabel: e.dateLabel, active: e.id === activeId })),
          transactions: transactions.map((t) => toTransaction(t, stockOf)),
          stockAdjustments: movements.map((m) => ({ id: m.id, productName: m.productName, variantName: m.variantName, delta: m.delta, reason: m.reason, createdAt: m.createdAt, actor: m.actor })),
        }
      })
    },

    async createTransaction(input: CheckoutInput): Promise<Transaction> {
      await ready()
      const actor = (await settings()).defaultCashier
      const cash = rupiah(input.cashReceived, 'Uang diterima')
      const merged = new Map<string, { productId: string; variantId: string; quantity: number }>()
      for (const item of input.items) {
        if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) fail('VALIDATION', 'Jumlah barang tidak valid.')
        const prev = merged.get(item.variantId)
        merged.set(item.variantId, { productId: item.productId, variantId: item.variantId, quantity: (prev?.quantity ?? 0) + item.quantity })
      }
      const lines = [...merged.values()]
      if (!lines.length) fail('EMPTY_CART', 'Keranjang masih kosong.')
      const signature = checkoutSignature(input.eventId, lines, cash)
      const prefix = (await settings()).receiptPrefix

      const row = await db.transaction('rw', [db.meta, db.events, db.products, db.transactions, db.stockMovements], async () => {
        if (input.idempotencyKey) {
          const existing = await db.transactions.get(input.idempotencyKey)
          if (existing) {
            if (checkoutSignature(existing.eventId, existing.items, existing.cashReceived) !== signature) fail('IDEMPOTENCY_CONFLICT', 'Kunci transaksi sudah dipakai untuk pesanan lain.')
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
        const total = valid.reduce((sum, { variant, line }) => sum + variant.price * line.quantity, 0)
        if (!Number.isSafeInteger(total)) fail('VALIDATION', 'Total terlalu besar.')
        if (cash < total) fail('INSUFFICIENT_CASH', 'Uang diterima masih kurang.', { total, cashReceived: cash })

        const seq = (((await db.meta.get('txSeq'))?.value as number | undefined) ?? 0) + 1
        const id = input.idempotencyKey ?? uuid()
        const movements: StockMovementRow[] = valid.map(({ product, variant, line }) => {
          variant.stock -= line.quantity
          return { id: uuid(), kind: 'sale', productId: product.id, variantId: variant.id, productName: product.name, variantName: variant.name, delta: -line.quantity, stockAfter: variant.stock, reason: 'Penjualan', actor, createdAt: timestamp, transactionId: id }
        })
        const tx: TransactionRow = {
          id, seq, number: `${prefix}-${String(seq).padStart(4, '0')}`, eventId: input.eventId, createdAt: timestamp, cashierName: actor,
          items: valid.map(({ product, variant, line }) => ({ productId: product.id, productName: product.name, variantId: variant.id, variantName: variant.name, sku: variant.sku, price: variant.price, quantity: line.quantity })),
          total, cashReceived: cash, change: cash - total, status: 'completed',
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
      if (!input.variants.length) fail('VALIDATION', 'Produk perlu minimal satu varian.')
      return db.transaction('rw', db.categories, db.products, db.stockMovements, async () => {
        if (!(await db.categories.get(input.categoryId))) fail('VALIDATION', 'Pilih kategori yang ada.')
        const existing = input.id ? await db.products.get(input.id) : undefined
        if (input.id && !existing) fail('NOT_FOUND', 'Produk tidak ditemukan.')
        const timestamp = now().toISOString()
        const movements: StockMovementRow[] = []
        const productId = existing?.id ?? uuid()
        const variants = input.variants.map((v): VariantRow => {
          const old = v.id ? existing?.variants.find((o) => o.id === v.id) : undefined
          const row = { id: old?.id ?? uuid(), name: text(v.name, 'Nama varian'), price: rupiah(v.price, 'Harga'), sku: v.sku?.trim() ?? old?.sku ?? '', stock: old ? old.stock : (v.stock === undefined ? 0 : rupiah(v.stock, 'Stok awal')) }
          if (!old && row.stock > 0) movements.push({ id: uuid(), kind: 'initial', productId, variantId: row.id, productName: name, variantName: row.name, delta: row.stock, stockAfter: row.stock, reason: 'Stok awal', actor, createdAt: timestamp })
          return row
        })
        const row: ProductRow = {
          id: productId, name, categoryId: input.categoryId, description: input.description?.trim() ?? existing?.description ?? '',
          accent: input.accent ?? existing?.accent ?? '#ffd6e7', featured: input.featured ?? existing?.featured ?? false, archived: false,
          variants, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp,
        }
        await db.products.put(row)
        if (movements.length) await db.stockMovements.bulkAdd(movements)
        return toProduct(row)
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
      const [all, products, categories] = await Promise.all([
        db.transactions.where('eventId').equals(eventId).toArray(),
        db.products.toArray(),
        db.categories.toArray(),
      ])
      const done = all.filter((t) => t.status === 'completed')
      const hours = new Map<number, { hour: number; revenue: number; transactions: number }>()
      const top = new Map<string, EventReport['topProducts'][number]>()
      const productCategories = new Map(products.map((product) => [product.id, product.categoryId]))
      const categoryNames = new Map(categories.map((category) => [category.id, category.name]))
      const topCategories = new Map<string, EventReport['topCategories'][number]>()
      for (const t of done) {
        const hour = new Date(t.createdAt).getHours()
        const bucket = hours.get(hour) ?? { hour, revenue: 0, transactions: 0 }
        bucket.revenue += t.total; bucket.transactions += 1; hours.set(hour, bucket)
        for (const item of t.items) {
          const entry = top.get(item.productId) ?? { productId: item.productId, productName: item.productName, quantity: 0, revenue: 0 }
          entry.quantity += item.quantity; entry.revenue += item.price * item.quantity; top.set(item.productId, entry)
          const mappedCategoryId = productCategories.get(item.productId)
          const categoryId = mappedCategoryId && categoryNames.has(mappedCategoryId) ? mappedCategoryId : 'uncategorized'
          const categoryName = categoryId === 'uncategorized' ? 'Tanpa kategori' : categoryNames.get(categoryId)!
          const categoryEntry = topCategories.get(categoryId) ?? { categoryId, categoryName, quantity: 0, revenue: 0 }
          categoryEntry.quantity += item.quantity; categoryEntry.revenue += item.price * item.quantity; topCategories.set(categoryId, categoryEntry)
        }
      }
      const revenue = done.reduce((sum, t) => sum + t.total, 0)
      return {
        eventId, revenue, transactionCount: done.length, voidCount: all.length - done.length,
        itemsSold: done.reduce((sum, t) => sum + t.items.reduce((n, i) => n + i.quantity, 0), 0),
        averageTicket: done.length ? Math.round(revenue / done.length) : 0,
        byHour: [...hours.values()].sort((a, b) => a.hour - b.hour),
        topProducts: [...top.values()].sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue).slice(0, 10),
        topCategories: [...topCategories.values()].sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue),
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
