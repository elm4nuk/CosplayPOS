import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { localDateTime, localParts, nowIso } from '../lib/time.ts';
import { getEvent, type PosEvent } from './events.ts';

export const summaryQuery = z.object({ top: z.coerce.number().int().min(1).max(100).default(10) });

export const exportQuery = z.object({
  type: z.enum(['transactions', 'items']).default('transactions'),
  delimiter: z.enum(['comma', 'semicolon']).default('comma'),
});

const UNCATEGORIZED = 'Tanpa kategori';

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
  byPaymentMethod: { method: 'cash' | 'qris'; transactionCount: number; revenue: number }[];
  byDay: { date: string; transactionCount: number; revenue: number; itemsSold: number }[];
  byHour: { date: string; hour: number; transactionCount: number; revenue: number; itemsSold: number }[];
  topProducts: { productId: number; productName: string; quantity: number; revenue: number }[];
  topVariants: { variantId: number; productName: string; variantName: string; sku: string; quantity: number; revenue: number }[];
  topCategories: { categoryName: string; quantity: number; revenue: number }[];
  byCashier: { cashierId: number; displayName: string; transactionCount: number; revenue: number }[];
}

export function eventSummary(ctx: Ctx, eventId: number, top: number): EventSummary {
  const { store } = ctx;
  const tz = ctx.config.timezone;
  // Baca dalam satu snapshot agar angka-angka konsisten satu sama lain.
  store.db.exec('BEGIN');
  try {
    const event = getEvent(store, eventId);
    const completed = store.get<{ n: number; revenue: number; items: number }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS revenue, COALESCE(SUM(item_count), 0) AS items
         FROM transactions WHERE event_id = ? AND status = 'completed'`,
      eventId,
    )!;
    const voided = store.get<{ n: number; amount: number }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS amount FROM transactions WHERE event_id = ? AND status = 'voided'`,
      eventId,
    )!;

    const methods = new Map(
      store
        .all<{ method: 'cash' | 'qris'; n: number; revenue: number }>(
          `SELECT payment_method AS method, COUNT(*) AS n, SUM(total) AS revenue
             FROM transactions WHERE event_id = ? AND status = 'completed' GROUP BY payment_method`,
          eventId,
        )
        .map((r) => [r.method, r]),
    );
    const byPaymentMethod = (['cash', 'qris'] as const).map((method) => ({
      method,
      transactionCount: methods.get(method)?.n ?? 0,
      revenue: methods.get(method)?.revenue ?? 0,
    }));

    // Tren per hari/jam dihitung di JS agar memakai zona waktu IANA yang benar.
    const days = new Map<string, EventSummary['byDay'][number]>();
    const hours = new Map<string, EventSummary['byHour'][number]>();
    for (const t of store.all<{ created_at: string; total: number; item_count: number }>(
      `SELECT created_at, total, item_count FROM transactions WHERE event_id = ? AND status = 'completed'`,
      eventId,
    )) {
      const { date, hour } = localParts(t.created_at, tz);
      const d = days.get(date) ?? { date, transactionCount: 0, revenue: 0, itemsSold: 0 };
      d.transactionCount++;
      d.revenue += t.total;
      d.itemsSold += t.item_count;
      days.set(date, d);
      const key = `${date}|${hour}`;
      const h = hours.get(key) ?? { date, hour, transactionCount: 0, revenue: 0, itemsSold: 0 };
      h.transactionCount++;
      h.revenue += t.total;
      h.itemsSold += t.item_count;
      hours.set(key, h);
    }
    const byDay = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
    const byHour = [...hours.values()].sort((a, b) => a.date.localeCompare(b.date) || a.hour - b.hour);

    const topProducts = store.all<{ productId: number; productName: string; quantity: number; revenue: number }>(
      `SELECT ti.product_id AS productId, p.name AS productName, SUM(ti.quantity) AS quantity, SUM(ti.line_total) AS revenue
         FROM transaction_items ti
         JOIN transactions t ON t.id = ti.transaction_id
         JOIN products p ON p.id = ti.product_id
        WHERE t.event_id = ? AND t.status = 'completed'
        GROUP BY ti.product_id
        ORDER BY quantity DESC, revenue DESC, productName
        LIMIT ?`,
      eventId,
      top,
    );
    const topVariants = store.all<EventSummary['topVariants'][number]>(
      `SELECT ti.variant_id AS variantId, p.name AS productName, v.name AS variantName, v.sku AS sku,
              SUM(ti.quantity) AS quantity, SUM(ti.line_total) AS revenue
         FROM transaction_items ti
         JOIN transactions t ON t.id = ti.transaction_id
         JOIN product_variants v ON v.id = ti.variant_id
         JOIN products p ON p.id = v.product_id
        WHERE t.event_id = ? AND t.status = 'completed'
        GROUP BY ti.variant_id
        ORDER BY quantity DESC, revenue DESC, productName, variantName
        LIMIT ?`,
      eventId,
      top,
    );
    const topCategories = store.all<EventSummary['topCategories'][number]>(
      `SELECT COALESCE(ti.category_name, ?) AS categoryName, SUM(ti.quantity) AS quantity, SUM(ti.line_total) AS revenue
         FROM transaction_items ti
         JOIN transactions t ON t.id = ti.transaction_id
        WHERE t.event_id = ? AND t.status = 'completed'
        GROUP BY COALESCE(ti.category_name, ?)
        ORDER BY quantity DESC, revenue DESC, categoryName
        LIMIT ?`,
      UNCATEGORIZED,
      eventId,
      UNCATEGORIZED,
      top,
    );
    const byCashier = store.all<EventSummary['byCashier'][number]>(
      `SELECT t.cashier_id AS cashierId, u.display_name AS displayName, COUNT(*) AS transactionCount, SUM(t.total) AS revenue
         FROM transactions t JOIN users u ON u.id = t.cashier_id
        WHERE t.event_id = ? AND t.status = 'completed'
        GROUP BY t.cashier_id
        ORDER BY revenue DESC, displayName`,
      eventId,
    );

    return {
      event,
      timezone: tz,
      generatedAt: nowIso(),
      totals: {
        revenue: completed.revenue,
        transactionCount: completed.n,
        itemsSold: completed.items,
        averageTransaction: completed.n ? Math.round(completed.revenue / completed.n) : 0,
        voidedCount: voided.n,
        voidedAmount: voided.amount,
      },
      byPaymentMethod,
      byDay,
      byHour,
      topProducts,
      topVariants,
      topCategories,
      byCashier,
    };
  } finally {
    store.db.exec('COMMIT');
  }
}

// ---------------------------------------------------------------- CSV

function csvCell(value: unknown, delimiter: string): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  let s = String(value);
  // Cegah CSV/formula injection di Excel.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (s.includes(delimiter) || /["\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

const PAYMENT_LABEL = { cash: 'tunai', qris: 'qris' } as const;

export function exportCsv(
  ctx: Ctx,
  eventId: number,
  q: z.output<typeof exportQuery>,
): { filename: string; body: string } {
  const { store } = ctx;
  const tz = ctx.config.timezone;
  const event = getEvent(store, eventId);
  const d = q.delimiter === 'semicolon' ? ';' : ',';
  const line = (cells: unknown[]) => cells.map((c) => csvCell(c, d)).join(d);
  const out: string[] = [];

  if (q.type === 'transactions') {
    out.push(
      line(['number', 'createdAtLocal', 'status', 'cashier', 'paymentMethod', 'itemCount', 'total', 'amountReceived', 'change', 'qrisReference', 'note', 'voidReason']),
    );
    for (const r of store.all<Record<string, string | number | null>>(
      `SELECT t.number, t.created_at, t.status, u.display_name AS cashier, t.payment_method, t.item_count, t.total,
              t.amount_received, t.change_amount, t.qris_reference, t.note, t.void_reason
         FROM transactions t JOIN users u ON u.id = t.cashier_id
        WHERE t.event_id = ? ORDER BY t.id`,
      eventId,
    )) {
      out.push(
        line([
          r.number,
          localDateTime(String(r.created_at), tz),
          r.status,
          r.cashier,
          PAYMENT_LABEL[r.payment_method as 'cash' | 'qris'],
          r.item_count,
          r.total,
          r.amount_received,
          r.change_amount,
          r.qris_reference,
          r.note,
          r.void_reason,
        ]),
      );
    }
  } else {
    out.push(
      line(['number', 'createdAtLocal', 'status', 'cashier', 'paymentMethod', 'sku', 'productName', 'variantName', 'categoryName', 'unitPrice', 'quantity', 'lineTotal']),
    );
    for (const r of store.all<Record<string, string | number | null>>(
      `SELECT t.number, t.created_at, t.status, u.display_name AS cashier, t.payment_method,
              ti.sku, ti.product_name, ti.variant_name, ti.category_name, ti.unit_price, ti.quantity, ti.line_total
         FROM transaction_items ti
         JOIN transactions t ON t.id = ti.transaction_id
         JOIN users u ON u.id = t.cashier_id
        WHERE t.event_id = ? ORDER BY t.id, ti.id`,
      eventId,
    )) {
      out.push(
        line([
          r.number,
          localDateTime(String(r.created_at), tz),
          r.status,
          r.cashier,
          PAYMENT_LABEL[r.payment_method as 'cash' | 'qris'],
          r.sku,
          r.product_name,
          r.variant_name,
          r.category_name ?? UNCATEGORIZED,
          r.unit_price,
          r.quantity,
          r.line_total,
        ]),
      );
    }
  }
  const safeCode = event.code.replace(/[^A-Za-z0-9]/g, '');
  return {
    filename: `${safeCode}-${q.type}.csv`,
    body: `﻿${out.join('\r\n')}\r\n`,
  };
}

