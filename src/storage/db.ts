import Dexie, { type Table } from 'dexie'

/**
 * Local persistence schema (IndexedDB via Dexie).
 *
 * Migration rule: never edit an existing `version(n)` block once it has shipped
 * in an APK. Add `version(n + 1)` with an `upgrade()` and a test that opens a
 * fixture written by version n. See docs/HANDOFF.md § Migrasi.
 *
 * All money values are integer rupiah. All timestamps are ISO-8601 strings.
 */

export const DB_NAME = 'cosplaypos-booth'
export const SCHEMA_VERSION = 2

export type CategoryRow = { id: string; name: string; color: string; sortOrder: number }

export type VariantRow = {
  id: string
  name: string
  price: number
  stock: number
  sku: string
  /** v2: a variant removed from a product after it was used stays here, hidden, so a void can still return stock. */
  archived?: boolean
  /** v2: "stok menipis" when `stock <= lowStockThreshold`. Unset = DEFAULT_LOW_STOCK_THRESHOLD. */
  lowStockThreshold?: number
}

export type ProductRow = {
  id: string
  name: string
  categoryId: string
  description: string
  accent: string
  /** v1 only. v2 moves the data URL to `images` and keeps `imageId`. */
  image?: string
  /** v2: key into `images`. */
  imageId?: string
  featured: boolean
  archived: boolean
  archivedAt?: string
  variants: VariantRow[]
  createdAt: string
  updatedAt: string
}

export type EventRow = {
  id: string
  name: string
  venue: string
  dateLabel: string
  createdAt: string
  /** v2: archived events keep their sales and reports but take no new sales. */
  archived?: boolean
  archivedAt?: string
}

export type TransactionItemRow = {
  productId: string
  productName: string
  variantId: string
  variantName: string
  sku: string
  price: number
  quantity: number
}

/**
 * `confirmed`: cash counted, or QRIS the cashier explicitly confirmed on screen.
 * `legacy`: QRIS sale recorded before v2, when choosing QRIS alone marked it paid.
 * There is no payment gateway: nothing here means "verified by a bank".
 */
export type PaymentStatus = 'confirmed' | 'legacy'

/** Snapshot of the bundle as priced by the service at checkout. */
export type TransactionPromoRow = {
  bundleId: string
  name: string
  bundlePrice: number
  normalPrice: number
  discount: number
  items: { productId: string; variantId: string; quantity: number }[]
}

export type TransactionRow = {
  id: string
  number: string
  seq: number
  eventId: string
  createdAt: string
  cashierName: string
  items: TransactionItemRow[]
  subtotal?: number
  discount?: number
  promoName?: string
  /** v2: present when a bundle was applied. `discount`/`promoName` mirror it for old readers. */
  promo?: TransactionPromoRow
  total: number
  cashReceived: number
  change: number
  paymentMethod?: 'cash' | 'qris'
  /** v2: always set. */
  paymentStatus?: PaymentStatus
  paymentConfirmedAt?: string
  paymentConfirmedBy?: string
  /** v2: optional short QRIS note typed by the cashier (no phone/account/card numbers). */
  paymentReference?: string
  /** v2: cash session open when the sale was made. */
  cashSessionId?: string
  status: 'completed' | 'void'
  voidedAt?: string
  voidReason?: string
}

export type MovementKind = 'initial' | 'sale' | 'adjustment' | 'void' | 'opname'

export type StockMovementRow = {
  id: string
  kind: MovementKind
  productId: string
  variantId: string
  productName: string
  variantName: string
  delta: number
  stockAfter: number
  reason: string
  actor: string
  createdAt: string
  transactionId?: string
  /**
   * v2: a v1 build could delete a whole event together with its sales. Their
   * stock movements are kept for the audit trail; the dangling id moves here so
   * `transactionId` only ever points at an existing transaction.
   */
  legacyTransactionId?: string
}

export type MetaRow = { key: string; value: unknown }

export type BundleItemRow = { productId: string; variantId: string; quantity: number }

export type BundleRow = {
  id: string
  name: string
  description: string
  price: number
  items: BundleItemRow[]
  active: boolean
  createdAt: string
  updatedAt: string
}

/** A compressed image as a data URL. Products point here through `imageId`. */
export type ImageRow = { id: string; dataUrl: string; mime: string; bytes: number; createdAt: string }

export type CashSessionRow = {
  id: string
  status: 'open' | 'closed'
  eventId: string
  openedAt: string
  openedBy: string
  openingCash: number
  openingNote: string
  closedAt?: string
  closedBy?: string
  /** Snapshot taken at close: completed cash sales tagged with this session. */
  cashSales?: number
  transactionCount?: number
  expectedCash?: number
  countedCash?: number
  /** countedCash - expectedCash. Negative = short, positive = over. */
  difference?: number
  closingNote?: string
}

export class PosDatabase extends Dexie {
  meta!: Table<MetaRow, string>
  categories!: Table<CategoryRow, string>
  products!: Table<ProductRow, string>
  events!: Table<EventRow, string>
  transactions!: Table<TransactionRow, string>
  stockMovements!: Table<StockMovementRow, string>
  bundles!: Table<BundleRow, string>
  images!: Table<ImageRow, string>
  cashSessions!: Table<CashSessionRow, string>

  constructor(name = DB_NAME) {
    super(name)
    this.version(1).stores({
      meta: 'key',
      categories: 'id, sortOrder',
      products: 'id, categoryId',
      events: 'id, createdAt',
      transactions: 'id, &number, seq, eventId, createdAt',
      stockMovements: 'id, variantId, createdAt, transactionId',
    })
    this.version(2).stores({
      transactions: 'id, &number, seq, eventId, createdAt, cashSessionId',
      stockMovements: 'id, variantId, createdAt, transactionId, productId',
      bundles: 'id',
      images: 'id',
      cashSessions: 'id, openedAt, status',
    }).upgrade(async (tx) => {
      const v1 = Object.fromEntries(await Promise.all(V1_TABLES.map(async (name) => [name, await tx.table(name).toArray()] as const))) as V1Data
      const v2 = migrateV1toV2(v1, { now: new Date().toISOString(), newId: () => crypto.randomUUID() })
      for (const name of DATA_TABLES) {
        await tx.table(name).clear()
        await tx.table(name).bulkAdd(v2[name])
      }
    })
  }
}

export const V1_TABLES = ['meta', 'categories', 'products', 'events', 'transactions', 'stockMovements'] as const
export const DATA_TABLES = [...V1_TABLES, 'bundles', 'images', 'cashSessions'] as const
export type DataTableName = (typeof DATA_TABLES)[number]

export type V1Data = Record<(typeof V1_TABLES)[number], unknown[]>
export type V2Data = {
  meta: MetaRow[]
  categories: CategoryRow[]
  products: ProductRow[]
  events: EventRow[]
  transactions: TransactionRow[]
  stockMovements: StockMovementRow[]
  bundles: BundleRow[]
  images: ImageRow[]
  cashSessions: CashSessionRow[]
}

const DATA_URL_MIME = /^data:(image\/[a-z0-9.+-]+);base64,/i

/**
 * Pure v1 → v2 row transform. Used by the Dexie upgrade above AND by restore of
 * a v1 backup file, so a phone upgraded in place and a phone restored from an
 * old backup end up with the same data.
 *
 * - events: `archived: false`.
 * - products: inline `image` → `images` row + `imageId` (kept as-is, never re-encoded).
 * - transactions: `paymentMethod` made explicit; `paymentStatus` = `confirmed`
 *   for cash, `legacy` for QRIS (v1 never asked the cashier to confirm).
 * - meta `bundles` array → `bundles` table.
 * - stock movements pointing at a deleted transaction keep their history but
 *   move the dangling id to `legacyTransactionId`.
 */
export function migrateV1toV2(data: V1Data, ctx: { now: string; newId: () => string }): V2Data {
  const images: ImageRow[] = []
  const products = (data.products as ProductRow[]).map((row): ProductRow => {
    const { image, ...rest } = row
    if (!image) return { ...rest }
    const id = ctx.newId()
    images.push({ id, dataUrl: image, mime: DATA_URL_MIME.exec(image)?.[1]?.toLowerCase() ?? 'application/octet-stream', bytes: image.length, createdAt: row.updatedAt ?? ctx.now })
    return { ...rest, imageId: id }
  })
  const events = (data.events as EventRow[]).map((row): EventRow => ({ ...row, archived: row.archived ?? false }))
  const transactions = (data.transactions as TransactionRow[]).map((row): TransactionRow => {
    const method = row.paymentMethod ?? 'cash'
    return { ...row, paymentMethod: method, paymentStatus: row.paymentStatus ?? (method === 'qris' ? 'legacy' : 'confirmed') }
  })
  const txIds = new Set(transactions.map((t) => t.id))
  const stockMovements = (data.stockMovements as StockMovementRow[]).map((row): StockMovementRow => {
    if (!row.transactionId || txIds.has(row.transactionId)) return { ...row }
    const { transactionId, ...rest } = row
    return { ...rest, legacyTransactionId: transactionId }
  })
  const meta = data.meta as MetaRow[]
  const legacyBundles = (meta.find((row) => row.key === 'bundles')?.value as Record<string, unknown>[] | undefined) ?? []
  const bundles = legacyBundles.filter((b) => typeof b?.id === 'string').map((b): BundleRow => ({
    id: b.id as string,
    name: String(b.name ?? ''),
    description: String(b.description ?? ''),
    price: b.price as number,
    items: Array.isArray(b.items) ? (b.items as BundleItemRow[]).map(({ productId, variantId, quantity }) => ({ productId, variantId, quantity })) : [],
    active: b.active !== false,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  }))
  return {
    meta: meta.filter((row) => row.key !== 'bundles'),
    categories: data.categories as CategoryRow[],
    products, events, transactions, stockMovements, bundles, images, cashSessions: [],
  }
}
