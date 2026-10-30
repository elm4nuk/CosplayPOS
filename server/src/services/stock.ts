import { z } from 'zod';
import type { Ctx } from '../context.ts';
import type { Store } from '../db/store.ts';
import { AppError, notFound } from '../lib/errors.ts';
import { nowIso } from '../lib/time.ts';
import { cursorQuery, limitQuery, optionalText } from '../lib/validation.ts';
import { getActiveEvent } from './events.ts';
import { toVariant, VARIANT_COLS, type Variant, type VariantRow } from './catalog.ts';

export type MovementReason = 'initial' | 'restock' | 'correction' | 'damaged' | 'lost' | 'other' | 'sale' | 'void';

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

interface MovementRow {
  id: number;
  variant_id: number;
  product_id: number;
  product_name: string;
  variant_name: string;
  sku: string;
  delta: number;
  stock_after: number;
  reason: MovementReason;
  note: string | null;
  transaction_id: number | null;
  transaction_number: string | null;
  event_id: number | null;
  user_id: number | null;
  user_name: string | null;
  created_at: string;
}

const MOVEMENT_SELECT = `
  SELECT m.id, m.variant_id, v.product_id, p.name AS product_name, v.name AS variant_name, v.sku,
         m.delta, m.stock_after, m.reason, m.note, m.transaction_id, t.number AS transaction_number,
         m.event_id, m.user_id, u.display_name AS user_name, m.created_at
    FROM stock_movements m
    JOIN product_variants v ON v.id = m.variant_id
    JOIN products p ON p.id = v.product_id
    LEFT JOIN transactions t ON t.id = m.transaction_id
    LEFT JOIN users u ON u.id = m.user_id`;

const toMovement = (r: MovementRow): StockMovement => ({
  id: r.id,
  variantId: r.variant_id,
  productId: r.product_id,
  productName: r.product_name,
  variantName: r.variant_name,
  sku: r.sku,
  delta: r.delta,
  stockAfter: r.stock_after,
  reason: r.reason,
  note: r.note,
  transactionId: r.transaction_id,
  transactionNumber: r.transaction_number,
  eventId: r.event_id,
  userId: r.user_id,
  userName: r.user_name,
  createdAt: r.created_at,
});

export interface NewMovement {
  variantId: number;
  delta: number;
  stockAfter: number;
  reason: MovementReason;
  note: string | null;
  transactionId: number | null;
  eventId: number | null;
  userId: number | null;
  createdAt: string;
}

export function insertMovement(store: Store, m: NewMovement): number {
  const r = store.run(
    `INSERT INTO stock_movements (variant_id, delta, stock_after, reason, note, transaction_id, event_id, user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    m.variantId,
    m.delta,
    m.stockAfter,
    m.reason,
    m.note,
    m.transactionId,
    m.eventId,
    m.userId,
    m.createdAt,
  );
  return Number(r.lastInsertRowid);
}

export const adjustStockSchema = z
  .object({
    delta: z.number().int().min(-1_000_000).max(1_000_000).optional(),
    setTo: z.number().int().min(0).max(1_000_000).optional(),
    expectedStock: z.number().int().min(0).optional(),
    reason: z.enum(['restock', 'correction', 'damaged', 'lost', 'other']),
    note: optionalText(300),
  })
  .refine((b) => (b.delta === undefined) !== (b.setTo === undefined), {
    message: 'Isi tepat satu dari delta atau setTo',
    path: ['delta'],
  });

export function adjustStock(
  ctx: Ctx,
  userId: number,
  variantId: number,
  input: z.output<typeof adjustStockSchema>,
): { variant: Variant; movement: StockMovement } {
  const { store } = ctx;
  const result = store.tx(() => {
    const v = store.get<VariantRow>(`SELECT ${VARIANT_COLS} FROM product_variants WHERE id = ?`, variantId);
    if (!v) throw notFound('Varian');
    if (input.expectedStock !== undefined && input.expectedStock !== v.stock) {
      throw new AppError('STOCK_CHANGED', `Stok sudah berubah menjadi ${v.stock}. Periksa lagi sebelum menyimpan.`, {
        currentStock: v.stock,
      });
    }
    const target = input.setTo ?? v.stock + input.delta!;
    const delta = target - v.stock;
    if (target < 0) {
      throw new AppError('NEGATIVE_STOCK', `Stok tidak boleh negatif (stok sekarang ${v.stock})`, { currentStock: v.stock });
    }
    if (delta === 0) {
      throw new AppError('VALIDATION_ERROR', 'Tidak ada perubahan stok', { issues: [{ path: 'delta', message: 'Perubahan stok 0' }] });
    }
    const now = nowIso();
    store.run('UPDATE product_variants SET stock = ?, updated_at = ? WHERE id = ?', target, now, variantId);
    const movementId = insertMovement(store, {
      variantId,
      delta,
      stockAfter: target,
      reason: input.reason,
      note: input.note ?? null,
      transactionId: null,
      eventId: getActiveEvent(store)?.id ?? null,
      userId,
      createdAt: now,
    });
    const fresh = store.get<VariantRow>(`SELECT ${VARIANT_COLS} FROM product_variants WHERE id = ?`, variantId)!;
    const movement = store.get<MovementRow>(`${MOVEMENT_SELECT} WHERE m.id = ?`, movementId)!;
    return { variant: toVariant(fresh), movement: toMovement(movement) };
  });
  ctx.bus.publish('stock', { changes: [{ variantId, productId: result.variant.productId, stock: result.variant.stock }] });
  return result;
}

export const listMovementsQuery = z.object({
  variantId: z.coerce.number().int().positive().optional(),
  productId: z.coerce.number().int().positive().optional(),
  eventId: z.coerce.number().int().positive().optional(),
  reason: z.enum(['initial', 'restock', 'correction', 'damaged', 'lost', 'other', 'sale', 'void']).optional(),
  limit: limitQuery,
  before: cursorQuery,
});

export function listMovements(ctx: Ctx, q: z.output<typeof listMovementsQuery>): { items: StockMovement[]; nextCursor: number | null } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.variantId) (where.push('m.variant_id = ?'), params.push(q.variantId));
  if (q.productId) (where.push('v.product_id = ?'), params.push(q.productId));
  if (q.eventId) (where.push('m.event_id = ?'), params.push(q.eventId));
  if (q.reason) (where.push('m.reason = ?'), params.push(q.reason));
  if (q.before) (where.push('m.id < ?'), params.push(q.before));
  const rows = ctx.store.all<MovementRow>(
    `${MOVEMENT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY m.id DESC LIMIT ?`,
    ...params,
    q.limit + 1,
  );
  const hasMore = rows.length > q.limit;
  const items = rows.slice(0, q.limit).map(toMovement);
  return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
}
