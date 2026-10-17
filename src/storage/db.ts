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
export const SCHEMA_VERSION = 1

export type CategoryRow = { id: string; name: string; color: string; sortOrder: number }

export type VariantRow = { id: string; name: string; price: number; stock: number; sku: string }

export type ProductRow = {
  id: string
  name: string
  categoryId: string
  description: string
  accent: string
  image?: string
  featured: boolean
  archived: boolean
  variants: VariantRow[]
  createdAt: string
  updatedAt: string
}

export type EventRow = { id: string; name: string; venue: string; dateLabel: string; createdAt: string }

export type TransactionItemRow = {
  productId: string
  productName: string
  variantId: string
  variantName: string
  sku: string
  price: number
  quantity: number
}

export type TransactionRow = {
  id: string
  number: string
  seq: number
  eventId: string
  createdAt: string
  cashierName: string
  items: TransactionItemRow[]
  total: number
  cashReceived: number
  change: number
  paymentMethod?: 'cash' | 'qris'
  status: 'completed' | 'void'
  voidedAt?: string
  voidReason?: string
}

export type MovementKind = 'initial' | 'sale' | 'adjustment' | 'void'

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
}

export type MetaRow = { key: string; value: unknown }

export class PosDatabase extends Dexie {
  meta!: Table<MetaRow, string>
  categories!: Table<CategoryRow, string>
  products!: Table<ProductRow, string>
  events!: Table<EventRow, string>
  transactions!: Table<TransactionRow, string>
  stockMovements!: Table<StockMovementRow, string>

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
  }
}

export const DATA_TABLES = ['meta', 'categories', 'products', 'events', 'transactions', 'stockMovements'] as const
export type DataTableName = (typeof DATA_TABLES)[number]
