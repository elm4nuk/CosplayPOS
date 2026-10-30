import { z } from 'zod';
import type { AuthUser, Ctx } from '../context.ts';
import type { Store } from '../db/store.ts';
import { AppError, notFound } from '../lib/errors.ts';
import { sha256 } from '../lib/password.ts';
import { nowIso } from '../lib/time.ts';
import { cursorQuery, limitQuery, optionalText, rupiah, text } from '../lib/validation.ts';
import { insertMovement } from './stock.ts';

export type PaymentMethod = 'cash' | 'qris';
export type TransactionStatus = 'completed' | 'voided';

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

interface TxRow {
  id: number;
  number: string;
  client_request_id: string;
  request_fingerprint: string;
  event_id: number;
  event_name: string;
  cashier_id: number;
  cashier_name: string;
  payment_method: PaymentMethod;
  status: TransactionStatus;
  subtotal: number;
  total: number;
  amount_received: number;
  change_amount: number;
  item_count: number;
  qris_reference: string | null;
  note: string | null;
  created_at: string;
  voided_at: string | null;
  voided_by: number | null;
  voided_by_name: string | null;
  void_reason: string | null;
}

interface ItemRow {
  id: number;
  transaction_id: number;
  variant_id: number;
  product_id: number;
  product_name: string;
  variant_name: string;
  sku: string;
  category_name: string | null;
  unit_price: number;
  quantity: number;
  line_total: number;
}

const TX_SELECT = `
  SELECT t.*, e.name AS event_name, u.display_name AS cashier_name, vu.display_name AS voided_by_name
    FROM transactions t
    JOIN events e ON e.id = t.event_id
    JOIN users u ON u.id = t.cashier_id
    LEFT JOIN users vu ON vu.id = t.voided_by`;

const ITEM_COLS =
  'id, transaction_id, variant_id, product_id, product_name, variant_name, sku, category_name, unit_price, quantity, line_total';

const toItem = (r: ItemRow): TransactionItem => ({
  id: r.id,
  variantId: r.variant_id,
  productId: r.product_id,
  productName: r.product_name,
  variantName: r.variant_name,
  sku: r.sku,
  categoryName: r.category_name,
  unitPrice: r.unit_price,
  quantity: r.quantity,
  lineTotal: r.line_total,
});

const toTransaction = (r: TxRow, items: TransactionItem[]): Transaction => ({
  id: r.id,
  number: r.number,
  clientRequestId: r.client_request_id,
  eventId: r.event_id,
  eventName: r.event_name,
  cashier: { id: r.cashier_id, displayName: r.cashier_name },
  paymentMethod: r.payment_method,
  status: r.status,
  items,
  itemCount: r.item_count,
  subtotal: r.subtotal,
  total: r.total,
  amountReceived: r.amount_received,
  change: r.change_amount,
  qrisReference: r.qris_reference,
  note: r.note,
  createdAt: r.created_at,
  voidedAt: r.voided_at,
  voidedBy: r.voided_by !== null ? { id: r.voided_by, displayName: r.voided_by_name ?? '' } : null,
  voidReason: r.void_reason,
});

function hydrate(store: Store, rows: TxRow[]): Transaction[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const items = store.db
    .prepare(`SELECT ${ITEM_COLS} FROM transaction_items WHERE transaction_id IN (${placeholders}) ORDER BY id`)
    .all(...ids) as unknown as ItemRow[];
  const byTx = new Map<number, TransactionItem[]>();
  for (const it of items) {
    const list = byTx.get(it.transaction_id) ?? [];
    list.push(toItem(it));
    byTx.set(it.transaction_id, list);
  }
  return rows.map((r) => toTransaction(r, byTx.get(r.id) ?? []));
}

export function getTransaction(store: Store, ref: string | number): Transaction {
  const isId = typeof ref === 'number' || /^\d+$/.test(ref);
  const row = isId
    ? store.get<TxRow>(`${TX_SELECT} WHERE t.id = ?`, Number(ref))
    : store.get<TxRow>(`${TX_SELECT} WHERE t.number = ? COLLATE NOCASE`, String(ref));
  if (!row) throw notFound('Transaksi');
  return hydrate(store, [row])[0]!;
}

// ---------------------------------------------------------------- Checkout

export const checkoutSchema = z
  .object({
    clientRequestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'clientRequestId 8–64 karakter [A-Za-z0-9_-]'),
    eventId: z.number().int().positive(),
    paymentMethod: z.enum(['cash', 'qris']),
    items: z
      .array(z.object({ variantId: z.number().int().positive(), quantity: z.number().int().min(1).max(999) }))
      .min(1, 'Keranjang kosong')
      .max(100),
    amountReceived: rupiah.optional(),
    qrisConfirmed: z.boolean().optional(),
    qrisReference: optionalText(100),
    expectedTotal: rupiah.optional(),
    note: optionalText(500),
  })
  .superRefine((b, c) => {
    if (b.paymentMethod === 'cash' && b.amountReceived === undefined) {
      c.addIssue({ code: 'custom', path: ['amountReceived'], message: 'Uang diterima wajib diisi untuk pembayaran tunai' });
    }
    if (b.paymentMethod === 'qris' && b.qrisConfirmed !== true) {
      c.addIssue({
        code: 'custom',
        path: ['qrisConfirmed'],
        message: 'Konfirmasi bahwa pembayaran QRIS sudah diterima (qrisConfirmed: true)',
      });
    }
  });

export type CheckoutInput = z.output<typeof checkoutSchema>;

interface CheckoutVariantRow {
  variant_id: number;
  variant_name: string;
  sku: string;
  price: number;
  stock: number;
  variant_active: number;
  product_id: number;
  product_name: string;
  product_active: number;
  category_id: number | null;
  category_name: string | null;
}

/** Gabungkan baris dengan variantId sama, urutkan agar sidik request stabil. */
function normalizeItems(items: CheckoutInput['items']): { variantId: number; quantity: number }[] {
  const merged = new Map<number, number>();
  for (const it of items) merged.set(it.variantId, (merged.get(it.variantId) ?? 0) + it.quantity);
  return [...merged.entries()].map(([variantId, quantity]) => ({ variantId, quantity })).sort((a, b) => a.variantId - b.variantId);
}

export function checkout(ctx: Ctx, cashier: AuthUser, input: CheckoutInput): { transaction: Transaction; replayed: boolean } {
  const { store } = ctx;
  const items = normalizeItems(input.items);
  for (const it of items) {
    if (it.quantity > 999) {
      throw new AppError('VALIDATION_ERROR', 'Jumlah per item maksimal 999', { issues: [{ path: 'items', message: 'quantity > 999' }] });
    }
  }
  const amountReceivedInput = input.paymentMethod === 'cash' ? input.amountReceived! : null;
  const fingerprint = sha256(
    JSON.stringify({
      cashierId: cashier.id,
      eventId: input.eventId,
      paymentMethod: input.paymentMethod,
      items,
      amountReceived: amountReceivedInput,
      qrisReference: input.qrisReference ?? null,
      note: input.note ?? null,
    }),
  );

  const outcome = store.tx(() => {
    // 1. Idempotensi — sebelum semua pengecekan lain, agar retry tetap mendapat transaksi aslinya
    //    walau event sudah ditutup atau stok sudah habis setelahnya.
    const existing = store.get<{ id: number; request_fingerprint: string }>(
      'SELECT id, request_fingerprint FROM transactions WHERE client_request_id = ?',
      input.clientRequestId,
    );
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) {
        throw new AppError('IDEMPOTENCY_CONFLICT', 'clientRequestId ini sudah dipakai untuk transaksi lain. Buat ID baru untuk keranjang baru.', {
          transactionId: existing.id,
        });
      }
      return { transactionId: existing.id, replayed: true, stockChanges: [] as StockChange[] };
    }

    // 2. Event
    const event = store.get<{ id: number; code: string; status: string; name: string }>(
      'SELECT id, code, status, name FROM events WHERE id = ?',
      input.eventId,
    );
    if (!event) throw notFound('Event');
    if (event.status !== 'active') {
      throw new AppError('EVENT_NOT_ACTIVE', `Event "${event.name}" tidak aktif. Transaksi hanya bisa dicatat ke event yang aktif.`);
    }

    // 3. Produk & harga dari database
    const placeholders = items.map(() => '?').join(',');
    const rows = store.db
      .prepare(
        `SELECT v.id AS variant_id, v.name AS variant_name, v.sku, v.price, v.stock, v.active AS variant_active,
                p.id AS product_id, p.name AS product_name, p.active AS product_active,
                c.id AS category_id, c.name AS category_name
           FROM product_variants v
           JOIN products p ON p.id = v.product_id
           LEFT JOIN categories c ON c.id = p.category_id
          WHERE v.id IN (${placeholders})`,
      )
      .all(...items.map((i) => i.variantId)) as unknown as CheckoutVariantRow[];
    const byId = new Map(rows.map((r) => [r.variant_id, r]));

    const unavailable = items
      .filter((it) => {
        const r = byId.get(it.variantId);
        return !r || r.variant_active !== 1 || r.product_active !== 1;
      })
      .map((it) => it.variantId);
    if (unavailable.length > 0) {
      throw new AppError('PRODUCT_UNAVAILABLE', 'Ada produk yang sudah tidak dijual. Muat ulang katalog.', { variantIds: unavailable });
    }

    const lines = items.map((it) => {
      const r = byId.get(it.variantId)!;
      return { ...it, row: r, lineTotal: r.price * it.quantity };
    });

    // 4. Stok (cek semua dulu supaya kasir melihat semua item yang kurang sekaligus)
    const short = lines
      .filter((l) => l.row.stock < l.quantity)
      .map((l) => ({
        variantId: l.variantId,
        productName: l.row.product_name,
        variantName: l.row.variant_name,
        requested: l.quantity,
        available: l.row.stock,
      }));
    if (short.length > 0) {
      const first = short[0]!;
      const label = first.variantName ? `${first.productName} – ${first.variantName}` : first.productName;
      throw new AppError(
        'INSUFFICIENT_STOCK',
        `Stok tidak cukup untuk ${label} (sisa ${first.available}, diminta ${first.requested})` +
          (short.length > 1 ? ` dan ${short.length - 1} item lain` : ''),
        { items: short },
      );
    }

    // 5. Total & pembayaran
    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    const total = subtotal;
    const itemCount = lines.reduce((s, l) => s + l.quantity, 0);
    if (input.expectedTotal !== undefined && input.expectedTotal !== total) {
      throw new AppError('PRICE_CHANGED', 'Harga berubah sejak keranjang dibuat. Periksa total baru.', {
        expectedTotal: input.expectedTotal,
        actualTotal: total,
      });
    }
    let amountReceived: number;
    let change: number;
    if (input.paymentMethod === 'cash') {
      amountReceived = amountReceivedInput!;
      if (amountReceived < total) {
        throw new AppError('INSUFFICIENT_PAYMENT', 'Uang diterima kurang dari total', { total, amountReceived });
      }
      change = amountReceived - total;
    } else {
      amountReceived = total;
      change = 0;
    }

    // 6. Kurangi stok secara kondisional — jaring pengaman walau pengecekan di atas sudah lolos.
    const now = nowIso();
    const stockChanges: StockChange[] = [];
    for (const l of lines) {
      const updated = store.get<{ stock: number }>(
        'UPDATE product_variants SET stock = stock - ?, updated_at = ? WHERE id = ? AND stock >= ? RETURNING stock',
        l.quantity,
        now,
        l.variantId,
        l.quantity,
      );
      if (!updated) {
        throw new AppError('INSUFFICIENT_STOCK', `Stok tidak cukup untuk ${l.row.product_name}`, {
          items: [{ variantId: l.variantId, requested: l.quantity, available: l.row.stock }],
        });
      }
      stockChanges.push({ variantId: l.variantId, productId: l.row.product_id, stock: updated.stock });
    }

    // 7. Nomor transaksi & simpan
    const seq = store.get<{ seq: number }>('UPDATE events SET next_seq = next_seq + 1 WHERE id = ? RETURNING next_seq - 1 AS seq', event.id)!.seq;
    const number = `${event.code.toUpperCase()}-${String(seq).padStart(4, '0')}`;
    const txId = Number(
      store.run(
        `INSERT INTO transactions (number, client_request_id, request_fingerprint, event_id, cashier_id, payment_method, status,
                                   subtotal, total, amount_received, change_amount, item_count, qris_reference, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)`,
        number,
        input.clientRequestId,
        fingerprint,
        event.id,
        cashier.id,
        input.paymentMethod,
        subtotal,
        total,
        amountReceived,
        change,
        itemCount,
        input.paymentMethod === 'qris' ? (input.qrisReference ?? null) : null,
        input.note ?? null,
        now,
      ).lastInsertRowid,
    );
    lines.forEach((l, i) => {
      store.run(
        `INSERT INTO transaction_items (transaction_id, variant_id, product_id, product_name, variant_name, sku, category_id, category_name,
                                        unit_price, quantity, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        txId,
        l.variantId,
        l.row.product_id,
        l.row.product_name,
        l.row.variant_name,
        l.row.sku,
        l.row.category_id,
        l.row.category_name,
        l.row.price,
        l.quantity,
        l.lineTotal,
      );
      insertMovement(store, {
        variantId: l.variantId,
        delta: -l.quantity,
        stockAfter: stockChanges[i]!.stock,
        reason: 'sale',
        note: null,
        transactionId: txId,
        eventId: event.id,
        userId: cashier.id,
        createdAt: now,
      });
    });
    return { transactionId: txId, replayed: false, stockChanges };
  });

  const transaction = getTransaction(store, outcome.transactionId);
  if (!outcome.replayed) {
    ctx.bus.publish('stock', { changes: outcome.stockChanges });
    ctx.bus.publish('transaction', pick(transaction));
  }
  return { transaction, replayed: outcome.replayed };
}

interface StockChange {
  variantId: number;
  productId: number;
  stock: number;
}

const pick = (t: Transaction) => ({ id: t.id, number: t.number, eventId: t.eventId, total: t.total, status: t.status });

// ---------------------------------------------------------------- List & void

export const listTransactionsQuery = z.object({
  eventId: z.coerce.number().int().positive().optional(),
  cashierId: z.coerce.number().int().positive().optional(),
  status: z.enum(['completed', 'voided']).optional(),
  paymentMethod: z.enum(['cash', 'qris']).optional(),
  q: z.string().trim().max(40).optional(),
  limit: limitQuery,
  before: cursorQuery,
});

export function listTransactions(ctx: Ctx, q: z.output<typeof listTransactionsQuery>): { items: Transaction[]; nextCursor: number | null } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.eventId) (where.push('t.event_id = ?'), params.push(q.eventId));
  if (q.cashierId) (where.push('t.cashier_id = ?'), params.push(q.cashierId));
  if (q.status) (where.push('t.status = ?'), params.push(q.status));
  if (q.paymentMethod) (where.push('t.payment_method = ?'), params.push(q.paymentMethod));
  if (q.q) (where.push("t.number LIKE ? ESCAPE '\\'"), params.push(`%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`));
  if (q.before) (where.push('t.id < ?'), params.push(q.before));
  const rows = ctx.store.all<TxRow>(
    `${TX_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.id DESC LIMIT ?`,
    ...params,
    q.limit + 1,
  );
  const hasMore = rows.length > q.limit;
  const items = hydrate(ctx.store, rows.slice(0, q.limit));
  return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
}

export const voidSchema = z.object({ reason: text(200) });

export function voidTransaction(ctx: Ctx, admin: AuthUser, ref: string | number, reason: string): Transaction {
  const { store } = ctx;
  const stockChanges: StockChange[] = [];
  let id = 0;
  store.tx(() => {
    const tx = getTransaction(store, ref);
    id = tx.id;
    if (tx.status === 'voided') throw new AppError('ALREADY_VOIDED', `Transaksi ${tx.number} sudah dibatalkan`);
    const now = nowIso();
    for (const it of tx.items) {
      const updated = store.get<{ stock: number; product_id: number }>(
        'UPDATE product_variants SET stock = stock + ?, updated_at = ? WHERE id = ? RETURNING stock, product_id',
        it.quantity,
        now,
        it.variantId,
      )!;
      insertMovement(store, {
        variantId: it.variantId,
        delta: it.quantity,
        stockAfter: updated.stock,
        reason: 'void',
        note: reason,
        transactionId: tx.id,
        eventId: tx.eventId,
        userId: admin.id,
        createdAt: now,
      });
      stockChanges.push({ variantId: it.variantId, productId: updated.product_id, stock: updated.stock });
    }
    store.run(
      "UPDATE transactions SET status = 'voided', voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?",
      now,
      admin.id,
      reason,
      tx.id,
    );
  });
  const transaction = getTransaction(store, id);
  ctx.bus.publish('stock', { changes: dedupeLast(stockChanges) });
  ctx.bus.publish('transaction', pick(transaction));
  return transaction;
}

function dedupeLast(changes: StockChange[]): StockChange[] {
  const m = new Map<number, StockChange>();
  for (const c of changes) m.set(c.variantId, c);
  return [...m.values()];
}
