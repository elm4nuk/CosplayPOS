/**
 * Tipe respons/request API — cerminan docs/API_CONTRACT.md (v1.0.0).
 * Dimiliki backend. Frontend boleh meng-import file ini (mis. `import type { Product } from '../../shared/api-types'`)
 * atau menyalinnya. Jangan diubah dari sisi frontend; minta perubahan lewat kontrak.
 */

export type Role = 'admin' | 'cashier';
export type EventStatus = 'planned' | 'active' | 'finished';
export type PaymentMethod = 'cash' | 'qris';
export type TransactionStatus = 'completed' | 'voided';
export type MovementReason = 'initial' | 'restock' | 'correction' | 'damaged' | 'lost' | 'other' | 'sale' | 'void';
export type AdjustReason = 'restock' | 'correction' | 'damaged' | 'lost' | 'other';
export type BackupKind = 'manual' | 'auto' | 'pre-restore';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INSUFFICIENT_STOCK'
  | 'IDEMPOTENCY_CONFLICT'
  | 'PRICE_CHANGED'
  | 'EVENT_NOT_ACTIVE'
  | 'PRODUCT_UNAVAILABLE'
  | 'ANOTHER_EVENT_ACTIVE'
  | 'DUPLICATE'
  | 'STOCK_CHANGED'
  | 'NEGATIVE_STOCK'
  | 'ALREADY_VOIDED'
  | 'LAST_ADMIN'
  | 'INVALID_STATE'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'INSUFFICIENT_PAYMENT'
  | 'INVALID_BACKUP'
  | 'TOO_MANY_ATTEMPTS'
  | 'INTERNAL_ERROR';

export interface ApiError {
  error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
}

export interface List<T> {
  items: T[];
}
export interface Page<T> extends List<T> {
  nextCursor: number | null;
}

export interface User {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  active: boolean;
  createdAt: string;
}

export interface LoginResponse {
  token: string;
  expiresAt: string;
  user: User;
}
export interface MeResponse {
  user: User;
  expiresAt: string;
}

export interface PosEvent {
  id: number;
  code: string;
  name: string;
  location: string | null;
  startDate: string;
  endDate: string;
  status: EventStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Category {
  id: number;
  name: string;
  sortOrder: number;
  active: boolean;
}

export interface Variant {
  id: number;
  productId: number;
  name: string;
  sku: string;
  price: number;
  stock: number;
  active: boolean;
  sortOrder: number;
}

export interface Product {
  id: number;
  name: string;
  categoryId: number | null;
  categoryName: string | null;
  description: string | null;
  imageUrl: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  variants: Variant[];
}

export interface StockMovement {
  id: number;
  variantId: number;
  productId: number;
  productName: string;
  variantName: string;
  sku: string;
  delta: number;
  stockAfter: number;
  reason: MovementReason;
  note: string | null;
  transactionId: number | null;
  transactionNumber: string | null;
  eventId: number | null;
  userId: number | null;
  userName: string | null;
  createdAt: string;
}

export interface TransactionItem {
  id: number;
  variantId: number;
  productId: number;
  productName: string;
  variantName: string;
  sku: string;
  categoryName: string | null;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
}

export interface Transaction {
  id: number;
  number: string;
  clientRequestId: string;
  eventId: number;
  eventName: string;
  cashier: { id: number; displayName: string };
  paymentMethod: PaymentMethod;
  status: TransactionStatus;
  items: TransactionItem[];
  itemCount: number;
  subtotal: number;
  total: number;
  amountReceived: number;
  change: number;
  qrisReference: string | null;
  note: string | null;
  createdAt: string;
  voidedAt: string | null;
  voidedBy: { id: number; displayName: string } | null;
  voidReason: string | null;
}

export interface CheckoutRequest {
  clientRequestId: string;
  eventId: number;
  paymentMethod: PaymentMethod;
  items: { variantId: number; quantity: number }[];
  amountReceived?: number;
  qrisConfirmed?: boolean;
  qrisReference?: string | null;
  expectedTotal?: number;
  note?: string | null;
}
export interface CheckoutResponse {
  transaction: Transaction;
  replayed: boolean;
}

export interface InsufficientStockDetails {
  items: { variantId: number; productName?: string; variantName?: string; requested: number; available: number }[];
}

export interface Settings {
  storeName: string;
  storeAddress: string | null;
  storePhone: string | null;
  receiptHeader: string | null;
  receiptFooter: string | null;
  lowStockThreshold: number;
  timezone: string;
}

export interface Receipt {
  store: { name: string; address: string | null; phone: string | null; header: string | null; footer: string | null };
  event: { id: number; code: string; name: string; location: string | null };
  transaction: Transaction;
  localTime: string;
  timezone: string;
}

export interface EventSummary {
  event: PosEvent;
  timezone: string;
  generatedAt: string;
  totals: {
    revenue: number;
    transactionCount: number;
    itemsSold: number;
    averageTransaction: number;
    voidedCount: number;
    voidedAmount: number;
  };
  byPaymentMethod: { method: PaymentMethod; transactionCount: number; revenue: number }[];
  byDay: { date: string; transactionCount: number; revenue: number; itemsSold: number }[];
  byHour: { date: string; hour: number; transactionCount: number; revenue: number; itemsSold: number }[];
  topProducts: { productId: number; productName: string; quantity: number; revenue: number }[];
  topVariants: { variantId: number; productName: string; variantName: string; sku: string; quantity: number; revenue: number }[];
  topCategories: { categoryName: string; quantity: number; revenue: number }[];
  byCashier: { cashierId: number; displayName: string; transactionCount: number; revenue: number }[];
}

export interface BackupInfo {
  name: string;
  sizeBytes: number;
  createdAt: string;
  kind: BackupKind;
}

export interface ServerInfo {
  name: string;
  version: string;
  port: number;
  lanUrls: string[];
  timezone: string;
  time: string;
  activeEvent: { id: number; code: string; name: string } | null;
}

/** Event Server-Sent Events dari GET /api/stream */
export interface StreamEvents {
  hello: { time: string };
  stock: { changes: { variantId: number; productId: number; stock: number }[] };
  transaction: { id: number; number: string; eventId: number; total: number; status: TransactionStatus };
  catalog: { productId?: number };
  event: { eventId: number };
  restore: Record<string, never>;
}
