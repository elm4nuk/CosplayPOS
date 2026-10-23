import { createBackup, parseBackup, restoreBackup, type BackupFile } from '../storage/backup'
import { PosDatabase, type BundleRow, type CategoryRow, type EventRow, type ImageRow, type ProductRow, type StockMovementRow, type TransactionRow, type VariantRow } from '../storage/db'
import { PosError } from '../storage/errors'
import { checkImageDataUrl } from '../storage/images'
import { formatReceiptText } from '../storage/receipt'
import type { BoothEvent, BootstrapData, Product, PromoBundle, PromoBundleItem, Transaction } from '../types'
import type { PosService } from './posService'

export type ShopSettings = { shopName: string; footer: string; receiptPrefix: string; defaultCashier: string; qrisImage?: string }
export type ReadyState = { firstRun: boolean }

export type CheckoutInput = {
  eventId: string
  /** Only ids and quantities are trusted; price and name come from the database. */
  items: { productId: string; variantId: string; quantity: number }[]
  cashReceived: number
  paymentMethod?: 'cash' | 'qris'
  /**
   * QRIS only, required `true`: the cashier saw the successful payment on the
   * customer's phone and pressed the confirm button. There is no gateway.
   */
  paymentConfirmed?: boolean
  /** QRIS only, optional: short note (≤ 40 chars, no phone/account/card numbers). */
  paymentReference?: string
  /** At most one bundle per transaction. The service prices it from the stored bundle. */
  bundleId?: string
  /** One key per checkout attempt. Retrying with the same key never sells twice. */
  idempotencyKey?: string
  /**
   * @deprecated The service computes the discount. Without `bundleId` any value
   * other than 0 is rejected (`PROMO_INVALID`, reason `UNTRUSTED_DISCOUNT`); with
   * `bundleId` it must equal the computed discount (`DISCOUNT_MISMATCH`).
   */
  discount?: number
  /** @deprecated Ignored. The receipt uses the stored bundle name. */
  promoName?: string
}

export type SaveProductInput = {
  id?: string
  name: string
  categoryId: string
  description?: string
  accent?: string
  /** JPEG/PNG/WebP data URL from `optimizeImageFile()`, `''` to remove, omitted to keep. */
  image?: string
  featured?: boolean
  variants?: { id?: string; name?: string; price: number; sku?: string; stock?: number; lowStockThreshold?: number | null }[]
  price?: number
  stock?: number
}

export type SaveBundleInput = { id?: string; name: string; description?: string; price: number; items: PromoBundleItem[]; active?: boolean }

export type PromoInvalidReason =
  | 'NOT_FOUND' | 'INACTIVE' | 'EMPTY' | 'DUPLICATE_ITEM' | 'PRODUCT_UNAVAILABLE' | 'VARIANT_NOT_FOUND'
  | 'INVALID_QUANTITY' | 'INVALID_PRICE' | 'NO_SAVING' | 'INSUFFICIENT_QUANTITY' | 'UNTRUSTED_DISCOUNT' | 'DISCOUNT_MISMATCH'

export type BundlePricing =
  | { bundleId: string; valid: true; normalPrice: number; bundlePrice: number; discount: number }
  | { bundleId: string; valid: false; reason: PromoInvalidReason; message: string }

export type EventReport = {
  eventId: string
  revenue: number
  cashRevenue: number
  qrisRevenue: number
  /** Sum of bundle discounts in completed sales. `revenue` is already net of it. */
  discountTotal: number
  /** Completed QRIS sales from before manual confirmation existed (`paymentStatus: 'legacy'`). */
  legacyQrisCount: number
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
const PAYMENT_REFERENCE_MAX = 40

const fail = (code: ConstructorParameters<typeof PosError>[0], message: string, details?: Record<string, unknown>): never => { throw new PosError(code, message, details) }
const promoFail = (reason: PromoInvalidReason, message: string, details?: Record<string, unknown>): never => fail('PROMO_INVALID', message, { reason, ...details })
const text = (value: unknown, label: string) => (typeof value === 'string' && value.trim() ? value.trim() : fail('VALIDATION', `${label} wajib diisi.`))
const rupiah = (value: unknown, label: string) => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : fail('VALIDATION', `${label} harus bilangan bulat rupiah ≥ 0.`))
const uuid = () => crypto.randomUUID()
const present = <T,>(value: T | undefined): value is T => value !== undefined

/**
 * QRIS note: free text for the cashier's own matching (e.g. last digits shown
 * on the customer's screen). Long digit runs are refused so phone, account and
 * card numbers don't end up in receipts and backups.
 */
function paymentReference(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') return fail('VALIDATION', 'Referensi QRIS harus teks.')
  const ref = value.trim().replace(/\s+/g, ' ')
  if (!ref) return undefined
  if (ref.length > PAYMENT_REFERENCE_MAX) fail('VALIDATION', `Referensi QRIS maksimal ${PAYMENT_REFERENCE_MAX} karakter.`)
  if (/\d{10,}/.test(ref.replace(/[\s.-]/g, ''))) fail('VALIDATION', 'Referensi QRIS tidak boleh berisi nomor HP, rekening, atau kartu. Cukup 4–6 digit terakhir.')
  if (!/^[\p{L}\p{N} .,#/_:-]+$/u.test(ref)) fail('VALIDATION', 'Referensi QRIS hanya boleh huruf, angka, spasi, dan . , # / _ : -')
  return ref
}

/**
 * Prices a stored bundle against current products. Throws PROMO_INVALID with
 * `details.reason`. One bundle = one application; it must be cheaper than the
 * normal price of its items.
 */
function priceBundle(bundle: BundleRow | undefined, productOf: (id: string) => ProductRow | undefined) {
  if (!bundle) return promoFail('NOT_FOUND', 'Promo bundle tidak ditemukan.')
  if (!bundle.active) promoFail('INACTIVE', `Promo ${bundle.name} sedang nonaktif.`)
  if (!Number.isSafeInteger(bundle.price) || bundle.price < 1) promoFail('INVALID_PRICE', `Harga promo ${bundle.name} tidak valid.`)
  if (!bundle.items.length) promoFail('EMPTY', `Promo ${bundle.name} tidak berisi produk.`)
  const seen = new Set<string>()
  let normalPrice = 0
  for (const item of bundle.items) {
    if (seen.has(item.variantId)) promoFail('DUPLICATE_ITEM', `Promo ${bundle.name} memuat varian yang sama dua kali.`, { variantId: item.variantId })
    seen.add(item.variantId)
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) promoFail('INVALID_QUANTITY', `Jumlah item di promo ${bundle.name} tidak valid.`)
    const product = productOf(item.productId)
    if (!product || product.archived) promoFail('PRODUCT_UNAVAILABLE', `Produk di promo ${bundle.name} sudah tidak tersedia.`, { productId: item.productId })
    const variant = product!.variants.find((v) => v.id === item.variantId && !v.archived)
    if (!variant) promoFail('VARIANT_NOT_FOUND', `Varian di promo ${bundle.name} sudah tidak ada.`, { variantId: item.variantId })
    normalPrice += variant!.price * item.quantity
  }
  if (!Number.isSafeInteger(normalPrice)) promoFail('INVALID_PRICE', 'Total harga promo terlalu besar.')
  if (bundle.price >= normalPrice) promoFail('NO_SAVING', `Harga promo ${bundle.name} tidak lebih murah dari harga normal.`, { normalPrice, bundlePrice: bundle.price })
  return { normalPrice, bundlePrice: bundle.price, discount: normalPrice - bundle.price }
}

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
      if (await db.meta.get('createdAt')) {
        // The active event must always be a live one (old data or a hand-edited backup may say otherwise).
        const current = await db.events.get((await activeEventId()) ?? '')
        if (!current || current.archived) {
          const fallback = (await db.events.orderBy('createdAt').toArray()).find((e) => !e.archived)
          if (fallback) await db.meta.put({ key: 'activeEventId', value: fallback.id })
        }
        return false
      }
      const event: EventRow = { id: uuid(), name: 'Event pertama', venue: '', dateLabel: now().toLocaleDateString('id-ID', { dateStyle: 'medium' }), createdAt: now().toISOString(), archived: false }
      await db.events.add(event)
      await db.meta.bulkPut([{ key: 'createdAt', value: now().toISOString() }, { key: 'activeEventId', value: event.id }, { key: 'txSeq', value: 0 }])
      return true
    })
    const obsoleteSecurityRows = (await db.meta.toArray()).map((row) => row.key).filter((key) => key.startsWith('pin:') || key.startsWith('pinGuard:'))
    if (obsoleteSecurityRows.length) await db.meta.bulkDelete(obsoleteSecurityRows)
    return { firstRun }
  }

  const ready = () => (readyPromise ??= init())

  const toProduct = (row: ProductRow, image?: string): Product => ({
    id: row.id, name: row.name, categoryId: row.categoryId, description: row.description, accent: row.accent, image, imageId: row.imageId, featured: row.featured,
    ...(row.archived ? { archived: true } : {}),
    variants: row.variants.filter((v) => !v.archived).map(({ id, name, price, stock, sku, lowStockThreshold }) => ({ id, name, price, stock, sku, ...(lowStockThreshold === undefined ? {} : { lowStockThreshold }) })),
  })

  const toEvent = (row: EventRow, activeId: string | undefined): BoothEvent => ({
    id: row.id, name: row.name, venue: row.venue, dateLabel: row.dateLabel, active: row.id === activeId && !row.archived, archived: Boolean(row.archived),
    ...(row.archivedAt ? { archivedAt: row.archivedAt } : {}),
  })

  const toBundle = (row: BundleRow): PromoBundle => ({ id: row.id, name: row.name, description: row.description, price: row.price, items: row.items.map((i) => ({ ...i })), active: row.active })

  const toTransaction = (row: TransactionRow, stockOf: Map<string, number>): Transaction => ({
    id: row.id, number: row.number, eventId: row.eventId, createdAt: row.createdAt, cashierName: row.cashierName,
    items: row.items.map((item) => ({ productId: item.productId, productName: item.productName, variantId: item.variantId, variantName: item.variantName, price: item.price, quantity: item.quantity, stock: stockOf.get(item.variantId) ?? 0 })),
    subtotal: row.subtotal ?? row.total, discount: row.discount ?? 0, promoName: row.promoName, bundleId: row.promo?.bundleId,
    total: row.total, cashReceived: row.cashReceived, change: row.change, paymentMethod: row.paymentMethod ?? 'cash',
    paymentStatus: row.paymentStatus ?? (row.paymentMethod === 'qris' ? 'legacy' : 'confirmed'), paymentConfirmedAt: row.paymentConfirmedAt, paymentConfirmedBy: row.paymentConfirmedBy, paymentReference: row.paymentReference,
    cashSessionId: row.cashSessionId, status: row.status, voidedAt: row.voidedAt, voidReason: row.voidReason,
  })

  const stockMap = (products: ProductRow[]) => new Map(products.flatMap((p) => p.variants.map((v) => [v.id, v.stock] as const)))

  const checkoutSignature = (eventId: string, items: { variantId: string; quantity: number }[], cash: number, method = 'cash', bundleId = '') =>
    `${eventId}|${method}|${cash}|${bundleId}|${items.map((i) => `${i.variantId}:${i.quantity}`).sort().join(',')}`

  /** True when any sale, void, adjustment, opname, or bundle points at this product (or one of `variantIds`). */
  async function isUsed(productId: string, variantIds?: string[]) {
    const ids = variantIds ? new Set(variantIds) : undefined
    const touches = (variantId: string) => !ids || ids.has(variantId)
    const moved = await db.stockMovements.where('productId').equals(productId).filter((m) => m.kind !== 'initial' && touches(m.variantId)).count()
    if (moved) return true
    const inBundle = (await db.bundles.toArray()).some((b) => b.items.some((i) => i.productId === productId && touches(i.variantId)))
    if (inBundle) return true
    return (await db.transactions.filter((t) => t.items.some((i) => i.productId === productId && touches(i.variantId))).count()) > 0
  }

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
      if (next.qrisImage) checkImageDataUrl(next.qrisImage)
      await db.meta.put({ key: 'settings', value: merged })
      return merged
    },

    async getBootstrap(): Promise<BootstrapData> {
      await ready()
      return db.transaction('r', [db.meta, db.categories, db.products, db.events, db.transactions, db.stockMovements, db.bundles, db.images], async () => {
        const [categories, products, events, transactions, movements, activeId, bundles] = await Promise.all([
          db.categories.orderBy('sortOrder').toArray(), db.products.toArray(), db.events.orderBy('createdAt').toArray(),
          db.transactions.orderBy('seq').reverse().toArray(), db.stockMovements.orderBy('createdAt').reverse().filter((m) => m.kind !== 'sale').limit(100).toArray(), activeEventId(),
          db.bundles.toArray(),
        ])
        const live = products.filter((p) => !p.archived)
        // Photos are loaded for the till only; archived products never pull their image into memory.
        const images = new Map((await db.images.bulkGet(live.map((p) => p.imageId).filter(present))).filter(present).map((img) => [img.id, img.dataUrl]))
        const stockOf = stockMap(products)
        return {
          categories: [ALL_CATEGORY, ...categories.map(({ id, name, color }) => ({ id, name, color }))],
          products: live.map((p) => toProduct(p, p.imageId ? images.get(p.imageId) : undefined)),
          events: events.filter((e) => !e.archived).map((e) => toEvent(e, activeId)),
          transactions: transactions.map((t) => toTransaction(t, stockOf)),
          stockAdjustments: movements.map((m) => ({ id: m.id, productName: m.productName, variantName: m.variantName, delta: m.delta, reason: m.reason, createdAt: m.createdAt, actor: m.actor, kind: m.kind as 'initial' | 'adjustment' | 'void' | 'opname' })),
          bundles: bundles.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(toBundle),
          archivedEvents: events.filter((e) => e.archived).map((e) => toEvent(e, activeId)),
          archivedProducts: products.filter((p) => p.archived).map((p) => toProduct(p)),
        }
      })
    },

    async createTransaction(input: CheckoutInput): Promise<Transaction> {
      await ready()
      const actor = (await settings()).defaultCashier
      const isQris = input.paymentMethod === 'qris'
      if (input.paymentMethod !== undefined && input.paymentMethod !== 'cash' && !isQris) fail('VALIDATION', 'Metode pembayaran tidak dikenal.')
      if (isQris && input.paymentConfirmed !== true) fail('PAYMENT_NOT_CONFIRMED', 'Konfirmasi dulu bahwa pembayaran QRIS sudah masuk di layar pembeli.')
      if (!isQris && input.paymentReference) fail('VALIDATION', 'Referensi pembayaran hanya untuk QRIS.')
      const reference = isQris ? paymentReference(input.paymentReference) : undefined
      const cash = isQris ? 0 : rupiah(input.cashReceived, 'Uang diterima')
      const bundleId = input.bundleId || undefined
      if (!bundleId && (input.discount ?? 0) !== 0) promoFail('UNTRUSTED_DISCOUNT', 'Diskon hanya bisa lewat promo bundle yang tersimpan. Pilih ulang promonya.')
      const merged = new Map<string, { productId: string; variantId: string; quantity: number }>()
      for (const item of input.items) {
        if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) fail('VALIDATION', 'Jumlah barang tidak valid.')
        const prev = merged.get(item.variantId)
        merged.set(item.variantId, { productId: item.productId, variantId: item.variantId, quantity: (prev?.quantity ?? 0) + item.quantity })
      }
      const lines = [...merged.values()]
      if (!lines.length) fail('EMPTY_CART', 'Keranjang masih kosong.')
      const signature = checkoutSignature(input.eventId, lines, cash, isQris ? 'qris' : 'cash', bundleId)
      const prefix = (await settings()).receiptPrefix

      const row = await db.transaction('rw', [db.meta, db.events, db.products, db.transactions, db.stockMovements, db.bundles, db.cashSessions], async () => {
        if (input.idempotencyKey) {
          const existing = await db.transactions.get(input.idempotencyKey)
          if (existing) {
            if (checkoutSignature(existing.eventId, existing.items, existing.paymentMethod === 'qris' ? 0 : existing.cashReceived, existing.paymentMethod ?? 'cash', existing.promo?.bundleId) !== signature) fail('IDEMPOTENCY_CONFLICT', 'Kunci transaksi sudah dipakai untuk pesanan lain.')
            return { tx: existing, replay: true }
          }
        }
        const event = (await db.events.get(input.eventId)) ?? fail('EVENT_NOT_FOUND', 'Event tidak ditemukan. Pilih event aktif lagi.')
        if (event.archived) fail('EVENT_ARCHIVED', `Event ${event.name} sudah diarsipkan. Pilih event aktif lain.`)

        const bundle = bundleId ? await db.bundles.get(bundleId) : undefined
        const productIds = [...new Set([...lines.map((l) => l.productId), ...(bundle?.items.map((i) => i.productId) ?? [])])]
        const products = new Map((await db.products.bulkGet(productIds)).filter(present).map((p) => [p.id, structuredClone(p)]))
        const shortages: { variantId: string; requested: number; available: number }[] = []
        const items = lines.map((line) => {
          const product = products.get(line.productId)
          const variant = product?.variants.find((v) => v.id === line.variantId)
          if (!product || !variant || product.archived || variant.archived) { shortages.push({ variantId: line.variantId, requested: line.quantity, available: 0 }); return null }
          if (variant.stock < line.quantity) shortages.push({ variantId: line.variantId, requested: line.quantity, available: variant.stock })
          return { product, variant, line }
        })
        if (shortages.length) fail('STOCK_CHANGED', 'Stok baru saja berubah. Periksa keranjang.', { shortages })
        const valid = items as { product: ProductRow; variant: VariantRow; line: (typeof lines)[number] }[]
        const subtotal = valid.reduce((sum, { variant, line }) => sum + variant.price * line.quantity, 0)

        let promo: TransactionRow['promo']
        if (bundleId) {
          const priced = priceBundle(bundle, (id) => products.get(id))
          for (const item of bundle!.items) {
            const inCart = merged.get(item.variantId)
            if (!inCart || inCart.productId !== item.productId || inCart.quantity < item.quantity) {
              promoFail('INSUFFICIENT_QUANTITY', `Keranjang belum memuat semua isi promo ${bundle!.name}.`, { variantId: item.variantId, required: item.quantity, inCart: inCart?.quantity ?? 0 })
            }
          }
          if (input.discount !== undefined && input.discount !== priced.discount) promoFail('DISCOUNT_MISMATCH', 'Diskon di layar berbeda dengan promo tersimpan. Muat ulang keranjang.', { expected: priced.discount, received: input.discount })
          promo = { bundleId: bundle!.id, name: bundle!.name, ...priced, items: bundle!.items.map(({ productId, variantId, quantity }) => ({ productId, variantId, quantity })) }
        }

        const timestamp = now().toISOString()
        const discount = promo?.discount ?? 0
        const total = subtotal - discount
        if (!Number.isSafeInteger(total) || total < 0) fail('VALIDATION', 'Total tidak valid.')
        const actualCash = isQris ? total : cash
        if (!isQris && cash < total) fail('INSUFFICIENT_CASH', 'Uang diterima masih kurang.', { total, cashReceived: cash })

        const seq = (((await db.meta.get('txSeq'))?.value as number | undefined) ?? 0) + 1
        const id = input.idempotencyKey ?? uuid()
        const session = await db.cashSessions.where('status').equals('open').first()
        const movements: StockMovementRow[] = valid.map(({ product, variant, line }) => {
          variant.stock -= line.quantity
          return { id: uuid(), kind: 'sale', productId: product.id, variantId: variant.id, productName: product.name, variantName: variant.name, delta: -line.quantity, stockAfter: variant.stock, reason: 'Penjualan', actor, createdAt: timestamp, transactionId: id }
        })
        const tx: TransactionRow = {
          id, seq, number: `${prefix}-${String(seq).padStart(4, '0')}`, eventId: input.eventId, createdAt: timestamp, cashierName: actor,
          items: valid.map(({ product, variant, line }) => ({ productId: product.id, productName: product.name, variantId: variant.id, variantName: variant.name, sku: variant.sku, price: variant.price, quantity: line.quantity })),
          subtotal, discount, ...(promo ? { promoName: promo.name, promo } : {}),
          total, cashReceived: actualCash, change: actualCash - total, paymentMethod: isQris ? 'qris' : 'cash',
          paymentStatus: 'confirmed', paymentConfirmedAt: timestamp, paymentConfirmedBy: actor, ...(reference ? { paymentReference: reference } : {}),
          ...(session ? { cashSessionId: session.id } : {}),
          status: 'completed',
        }
        await db.products.bulkPut(valid.map(({ product }) => product).filter((p, i, all) => all.indexOf(p) === i).map((p) => ({ ...p, updatedAt: timestamp })))
        await db.stockMovements.bulkAdd(movements)
        await db.transactions.add(tx)
        await db.meta.put({ key: 'txSeq', value: seq })
        return { tx, replay: false }
      })

      if (!row.replay) void maybeAutoBackup(row.tx.seq)
      const current = stockMap(await db.products.bulkGet(row.tx.items.map((i) => i.productId)).then((ps) => ps.filter(present)))
      return toTransaction(row.tx, current)
    },

    /**
     * Marks a sale void, stores its reason, and returns its items to stock
     * atomically. Archived products and archived variants still take their stock back.
     */
    async voidTransaction(transactionId: string, reason: string) {
      await ready()
      const actor = (await settings()).defaultCashier
      const why = text(reason, 'Alasan pembatalan')
      return db.transaction('rw', [db.products, db.transactions, db.stockMovements], async () => {
        const tx = (await db.transactions.get(transactionId)) ?? fail('NOT_FOUND', 'Transaksi tidak ditemukan.')
        if (tx.status === 'void') fail('ALREADY_VOID', 'Transaksi ini sudah dibatalkan.')
        const timestamp = now().toISOString()
        const products = new Map((await db.products.bulkGet([...new Set(tx.items.map((i) => i.productId))])).filter(present).map((p) => [p.id, p]))
        const movements: StockMovementRow[] = []
        for (const item of tx.items) {
          // Only data from before v2 can lack the variant (v1 allowed hard deletes); the void is still recorded.
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
        const users = await db.products.where('categoryId').equals(id).toArray()
        if (users.some((p) => !p.archived)) fail('VALIDATION', 'Kategori masih dipakai produk aktif.')
        // Archived products may be restored later and must keep a valid category.
        if (users.length) fail('VALIDATION', 'Kategori masih dipakai produk yang diarsipkan. Pindahkan produk itu ke kategori lain dulu.')
        await db.categories.delete(id)
      })
    },

    /**
     * Creates or edits a product. Variants left out of `variants` are removed
     * when they were never used; a used variant is archived instead (hidden,
     * stock kept) so old sales can still be voided. Editing never un-archives
     * the product.
     */
    async saveProduct(input: SaveProductInput) {
      await ready()
      const actor = (await settings()).defaultCashier
      const name = text(input.name, 'Nama produk')
      const rawVariants = input.variants && input.variants.length > 0
        ? input.variants
        : [{ name: 'Default', price: input.price ?? 0, stock: input.stock }]
      if (new Set(rawVariants.map((v) => v.id).filter(present)).size !== rawVariants.filter((v) => v.id).length) fail('VALIDATION', 'Varian yang sama dikirim dua kali.')
      if (input.image) checkImageDataUrl(input.image)
      const image = input.image
      return db.transaction('rw', [db.categories, db.products, db.stockMovements, db.images, db.bundles, db.transactions], async () => {
        if (!(await db.categories.get(input.categoryId))) fail('VALIDATION', 'Pilih kategori yang ada.')
        const existing = input.id ? await db.products.get(input.id) : undefined
        if (input.id && !existing) fail('NOT_FOUND', 'Produk tidak ditemukan.')
        const timestamp = now().toISOString()
        const movements: StockMovementRow[] = []
        const productId = existing?.id ?? uuid()
        const visible = existing?.variants.filter((v) => !v.archived) ?? []
        // Positional matching is only for callers that send no variant ids at all (single-variant forms).
        const positional = rawVariants.every((v) => !v.id)
        const variants = rawVariants.map((v, index): VariantRow => {
          const old = v.id
            ? existing?.variants.find((o) => o.id === v.id)
            : positional ? (visible[index] ?? (visible.length === 1 ? visible[0] : undefined)) : undefined
          const variantId = old?.id ?? v.id ?? uuid()
          const variantName = v.name?.trim() ? v.name.trim() : (old?.name ?? 'Default')
          const variantPrice = rupiah(v.price, 'Harga')
          const variantSku = v.sku?.trim() ?? old?.sku ?? ''
          const threshold = v.lowStockThreshold === null ? undefined : v.lowStockThreshold === undefined ? old?.lowStockThreshold : rupiah(v.lowStockThreshold, 'Batas stok menipis')
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
          return { id: variantId, name: variantName, price: variantPrice, sku: variantSku, stock, ...(threshold === undefined ? {} : { lowStockThreshold: threshold }) }
        })
        const kept = new Set(variants.map((v) => v.id))
        for (const old of existing?.variants ?? []) {
          if (kept.has(old.id)) continue
          if (old.archived || (await isUsed(productId, [old.id]))) variants.push({ ...old, archived: true })
        }

        let imageId = existing?.imageId
        if (image !== undefined) {
          const current = imageId ? await db.images.get(imageId) : undefined
          if (!image) {
            if (imageId) await db.images.delete(imageId)
            imageId = undefined
          } else if (current?.dataUrl !== image) {
            if (imageId) await db.images.delete(imageId)
            const row: ImageRow = { id: uuid(), dataUrl: image, mime: checkImageDataUrl(image).mime, bytes: image.length, createdAt: timestamp }
            await db.images.add(row)
            imageId = row.id
          }
        }

        const row: ProductRow = {
          id: productId, name, categoryId: input.categoryId, description: input.description?.trim() ?? existing?.description ?? '',
          accent: input.accent ?? existing?.accent ?? '#ffd6e7', ...(imageId ? { imageId } : {}),
          featured: input.featured ?? existing?.featured ?? false, archived: existing?.archived ?? false, ...(existing?.archivedAt ? { archivedAt: existing.archivedAt } : {}),
          variants, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp,
        }
        await db.products.put(row)
        if (movements.length) await db.stockMovements.bulkAdd(movements)
        return toProduct(row, imageId ? image || (await db.images.get(imageId))?.dataUrl : undefined)
      })
    },

    /**
     * Deletes a product only if nothing ever referenced it (no sale, void,
     * adjustment, opname, or bundle; its own "stok awal" rows go with it).
     * Otherwise it is archived. The result says which happened.
     */
    async deleteProduct(id: string): Promise<{ outcome: 'deleted' | 'archived' }> {
      await ready()
      return db.transaction('rw', [db.products, db.stockMovements, db.transactions, db.bundles, db.images], async () => {
        const product = (await db.products.get(id)) ?? fail('NOT_FOUND', 'Produk tidak ditemukan.')
        if (await isUsed(id)) {
          if (!product.archived) await db.products.put({ ...product, archived: true, archivedAt: now().toISOString(), updatedAt: now().toISOString() })
          return { outcome: 'archived' as const }
        }
        await db.stockMovements.where('productId').equals(id).delete()
        if (product.imageId) await db.images.delete(product.imageId)
        await db.products.delete(id)
        return { outcome: 'deleted' as const }
      })
    },
    async archiveProduct(id: string) {
      await ready()
      await db.transaction('rw', db.products, async () => {
        const product = (await db.products.get(id)) ?? fail('NOT_FOUND', 'Produk tidak ditemukan.')
        if (product.archived) return
        const timestamp = now().toISOString()
        await db.products.put({ ...product, archived: true, archivedAt: timestamp, updatedAt: timestamp })
      })
    },
    async unarchiveProduct(id: string) {
      await ready()
      return db.transaction('rw', db.products, db.categories, db.images, async () => {
        const product = (await db.products.get(id)) ?? fail('NOT_FOUND', 'Produk tidak ditemukan.')
        if (!(await db.categories.get(product.categoryId))) fail('VALIDATION', 'Kategori produk ini sudah dihapus. Edit produk dan pilih kategori dulu.')
        const row: ProductRow = { ...product, archived: false, updatedAt: now().toISOString() }
        delete row.archivedAt
        await db.products.put(row)
        return toProduct(row, row.imageId ? (await db.images.get(row.imageId))?.dataUrl : undefined)
      })
    },

    async saveEvent(input: { id?: string; name: string; venue?: string; dateLabel?: string }) {
      await ready()
      const existing = input.id ? await db.events.get(input.id) : undefined
      const row: EventRow = {
        id: input.id ?? uuid(), name: text(input.name, 'Nama event'), venue: input.venue?.trim() ?? '', dateLabel: input.dateLabel?.trim() ?? '',
        createdAt: existing?.createdAt || now().toISOString(), archived: existing?.archived ?? false, ...(existing?.archivedAt ? { archivedAt: existing.archivedAt } : {}),
      }
      await db.events.put(row)
      return row
    },
    async setActiveEvent(id: string) {
      await ready()
      await db.transaction('rw', db.meta, db.events, async () => {
        const event = (await db.events.get(id)) ?? fail('EVENT_NOT_FOUND', 'Event tidak ditemukan.')
        if (event.archived) fail('EVENT_ARCHIVED', `Event ${event.name} sudah diarsipkan. Pulihkan dulu untuk dipakai lagi.`)
        await db.meta.put({ key: 'activeEventId', value: id })
      })
    },
    /**
     * Archives an event. Its transactions, stock history, and reports stay
     * readable; it cannot take new sales. The active event needs a live
     * `replacementEventId`, which becomes active in the same transaction.
     */
    async archiveEvent(id: string, opts: { replacementEventId?: string } = {}): Promise<{ activeEventId: string }> {
      await ready()
      return db.transaction('rw', [db.meta, db.events, db.cashSessions], async () => {
        const event = (await db.events.get(id)) ?? fail('EVENT_NOT_FOUND', 'Event tidak ditemukan.')
        if (event.archived) fail('EVENT_ARCHIVED', 'Event ini sudah diarsipkan.')
        const openSession = await db.cashSessions.where('status').equals('open').first()
        if (openSession?.eventId === id) fail('CASH_SESSION_OPEN', 'Tutup sesi kas event ini dulu sebelum mengarsipkannya.')
        let active = (await activeEventId()) ?? id
        if (active === id) {
          const replacementId = opts.replacementEventId ?? fail('EVENT_REPLACEMENT_REQUIRED', 'Event ini sedang aktif. Pilih event pengganti sebelum mengarsipkannya.')
          if (replacementId === id) fail('VALIDATION', 'Event pengganti harus berbeda.')
          const replacement = (await db.events.get(replacementId)) ?? fail('EVENT_NOT_FOUND', 'Event pengganti tidak ditemukan.')
          if (replacement.archived) fail('EVENT_ARCHIVED', 'Event pengganti sudah diarsipkan.')
          await db.meta.put({ key: 'activeEventId', value: replacementId })
          active = replacementId
        }
        const timestamp = now().toISOString()
        await db.events.put({ ...event, archived: true, archivedAt: timestamp })
        return { activeEventId: active }
      })
    },
    async unarchiveEvent(id: string) {
      await ready()
      return db.transaction('rw', db.meta, db.events, async () => {
        const event = (await db.events.get(id)) ?? fail('EVENT_NOT_FOUND', 'Event tidak ditemukan.')
        const row: EventRow = { ...event, archived: false }
        delete row.archivedAt
        await db.events.put(row)
        return toEvent(row, await activeEventId())
      })
    },
    /**
     * @deprecated Use `archiveEvent`. Kept for the current UI: it ARCHIVES (never
     * deletes sales) and returns the new active event id when it changed.
     */
    async deleteEvent(id: string, replacementEventId?: string): Promise<string | undefined> {
      await ready()
      const before = await activeEventId()
      const { activeEventId: after } = await service.archiveEvent(id, { replacementEventId })
      return after !== before ? after : undefined
    },

    /** Works for archived events too: archiving never touches sales. */
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
        discountTotal: done.reduce((sum, t) => sum + (t.discount ?? 0), 0),
        legacyQrisCount: done.filter((t) => t.paymentMethod === 'qris' && t.paymentStatus !== 'confirmed').length,
        itemsSold: done.reduce((sum, t) => sum + t.items.reduce((n, i) => n + i.quantity, 0), 0),
        averageTicket: done.length ? Math.round(revenue / done.length) : 0,
        byHour: [...hours.values()].sort((a, b) => a.hour - b.hour),
        topProducts: [...top.values()].sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue).slice(0, 10),
      }
    },

    async getBundles(): Promise<PromoBundle[]> {
      await ready()
      return (await db.bundles.toArray()).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(toBundle)
    },

    /**
     * Saves a bundle after checking every product/variant exists and is live,
     * no variant repeats, quantities and price are positive integers. Whether
     * the price is below the normal total is checked at checkout (prices move);
     * `getBundlePricing()` shows it in advance.
     */
    async saveBundle(input: SaveBundleInput): Promise<PromoBundle> {
      await ready()
      const name = text(input.name, 'Nama bundle')
      const bundlePrice = rupiah(input.price, 'Harga bundle')
      if (bundlePrice < 1) fail('VALIDATION', 'Harga bundle harus lebih dari 0.')
      if (!input.items || !input.items.length) fail('VALIDATION', 'Bundle harus berisi minimal 1 item.')
      const seen = new Set<string>()
      for (const item of input.items) {
        if (!item.productId || !item.variantId) fail('VALIDATION', 'Produk dan varian dalam bundle wajib dipilih.')
        if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) fail('VALIDATION', 'Jumlah item bundle harus >= 1.')
        if (seen.has(item.variantId)) fail('VALIDATION', 'Varian yang sama tidak boleh muncul dua kali dalam satu bundle. Naikkan jumlahnya saja.')
        seen.add(item.variantId)
      }
      return db.transaction('rw', db.bundles, db.products, async () => {
        const products = new Map((await db.products.bulkGet([...new Set(input.items.map((i) => i.productId))])).filter(present).map((p) => [p.id, p]))
        for (const item of input.items) {
          const product = products.get(item.productId)
          if (!product || product.archived) fail('VALIDATION', 'Produk dalam bundle tidak ditemukan atau sudah diarsipkan.')
          if (!product!.variants.some((v) => v.id === item.variantId && !v.archived)) fail('VALIDATION', `Varian ${product!.name} dalam bundle tidak ditemukan.`)
        }
        const existing = input.id ? await db.bundles.get(input.id) : undefined
        const timestamp = now().toISOString()
        const row: BundleRow = {
          id: input.id ?? uuid(), name, description: input.description?.trim() ?? '', price: bundlePrice,
          items: input.items.map(({ productId, variantId, quantity }) => ({ productId, variantId, quantity })),
          active: input.active ?? existing?.active ?? true, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp,
        }
        await db.bundles.put(row)
        return toBundle(row)
      })
    },

    /** Transactions keep a full promo snapshot, so a bundle can be deleted any time. */
    async deleteBundle(id: string): Promise<void> {
      await ready()
      await db.bundles.delete(id)
    },

    async setBundleActive(id: string, active: boolean): Promise<void> {
      await ready()
      const updated = await db.bundles.update(id, { active, updatedAt: now().toISOString() })
      if (!updated && !(await db.bundles.get(id))) fail('NOT_FOUND', 'Promo bundle tidak ditemukan.')
    },

    async toggleBundleActive(id: string): Promise<void> {
      await ready()
      const bundle = (await db.bundles.get(id)) ?? fail('NOT_FOUND', 'Promo bundle tidak ditemukan.')
      await service.setBundleActive(id, !bundle.active)
    },

    /** Prices a stored bundle against current products without selling. */
    async getBundlePricing(bundleId: string): Promise<BundlePricing> {
      await ready()
      const bundle = await db.bundles.get(bundleId)
      const products = new Map((await db.products.bulkGet([...new Set(bundle?.items.map((i) => i.productId) ?? [])])).filter(present).map((p) => [p.id, p]))
      try {
        return { bundleId, valid: true, ...priceBundle(bundle, (id) => products.get(id)) }
      } catch (reason) {
        if (reason instanceof PosError && reason.code === 'PROMO_INVALID') return { bundleId, valid: false, reason: reason.details?.reason as PromoInvalidReason, message: reason.message }
        throw reason
      }
    },

    /** All events, archived ones included: they are past periods worth comparing. */
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
     * Backups from schema v1 are migrated in memory first (`upgradedFrom: 1`).
     */
    async restoreBackup(fileText: string) {
      await ready()
      const backup = await parseBackup(fileText)
      const previous = await createBackup(db, now())
      await restoreBackup(db, backup)
      readyPromise = null
      return { restored: backup.counts, previous, upgradedFrom: backup.upgradedFrom }
    },

    close() { db.close() },
  } satisfies PosService & Record<string, unknown>

  return service
}

export type LocalPosService = ReturnType<typeof createLocalPosService>
