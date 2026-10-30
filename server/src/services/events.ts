import { z } from 'zod';
import type { Ctx } from '../context.ts';
import type { Store } from '../db/store.ts';
import { AppError, notFound } from '../lib/errors.ts';
import { nowIso } from '../lib/time.ts';
import { isoDate, optionalText, text } from '../lib/validation.ts';

export type EventStatus = 'planned' | 'active' | 'finished';

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

interface EventRow {
  id: number;
  code: string;
  name: string;
  location: string | null;
  start_date: string;
  end_date: string;
  status: EventStatus;
  created_at: string;
  updated_at: string;
}

const COLS = 'id, code, name, location, start_date, end_date, status, created_at, updated_at';

const toEvent = (r: EventRow): PosEvent => ({
  id: r.id,
  code: r.code,
  name: r.name,
  location: r.location,
  startDate: r.start_date,
  endDate: r.end_date,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const codeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,12}$/, 'Kode event 2–12 karakter huruf/angka tanpa spasi');
const statusSchema = z.enum(['planned', 'active', 'finished']);

export const createEventSchema = z
  .object({
    code: codeSchema,
    name: text(100),
    location: optionalText(150),
    startDate: isoDate,
    endDate: isoDate,
    status: statusSchema.default('planned'),
  })
  .refine((e) => e.endDate >= e.startDate, { message: 'Tanggal selesai harus ≥ tanggal mulai', path: ['endDate'] });

export const updateEventSchema = z.object({
  code: codeSchema.optional(),
  name: text(100).optional(),
  location: optionalText(150),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
  status: statusSchema.optional(),
});

export function listEvents(ctx: Ctx): PosEvent[] {
  return ctx.store.all<EventRow>(`SELECT ${COLS} FROM events ORDER BY start_date DESC, id DESC`).map(toEvent);
}

export function getEvent(store: Store, id: number): PosEvent {
  const row = store.get<EventRow>(`SELECT ${COLS} FROM events WHERE id = ?`, id);
  if (!row) throw notFound('Event');
  return toEvent(row);
}

export function getActiveEvent(store: Store): PosEvent | null {
  const row = store.get<EventRow>(`SELECT ${COLS} FROM events WHERE status = 'active'`);
  return row ? toEvent(row) : null;
}

function assertNoOtherActive(store: Store, exceptId: number | null): void {
  const active = getActiveEvent(store);
  if (active && active.id !== exceptId) {
    throw new AppError('ANOTHER_EVENT_ACTIVE', `Event "${active.name}" masih aktif. Selesaikan dulu sebelum mengaktifkan event lain.`, {
      activeEventId: active.id,
    });
  }
}

function assertCodeFree(store: Store, code: string, exceptId: number | null): void {
  const row = store.get<{ id: number }>('SELECT id FROM events WHERE code = ?', code);
  if (row && row.id !== exceptId) throw new AppError('DUPLICATE', `Kode event "${code}" sudah dipakai`, { field: 'code' });
}

export function createEvent(ctx: Ctx, input: z.output<typeof createEventSchema>): PosEvent {
  const { store } = ctx;
  const event = store.tx(() => {
    assertCodeFree(store, input.code, null);
    if (input.status === 'active') assertNoOtherActive(store, null);
    const now = nowIso();
    const r = store.run(
      `INSERT INTO events (code, name, location, start_date, end_date, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.code,
      input.name,
      input.location ?? null,
      input.startDate,
      input.endDate,
      input.status,
      now,
      now,
    );
    return getEvent(store, Number(r.lastInsertRowid));
  });
  ctx.bus.publish('event', { eventId: event.id });
  return event;
}

export function updateEvent(ctx: Ctx, id: number, input: z.output<typeof updateEventSchema>): PosEvent {
  const { store } = ctx;
  const event = store.tx(() => {
    const before = getEvent(store, id);
    const next = {
      code: input.code ?? before.code,
      name: input.name ?? before.name,
      location: input.location === undefined ? before.location : input.location,
      startDate: input.startDate ?? before.startDate,
      endDate: input.endDate ?? before.endDate,
      status: input.status ?? before.status,
    };
    if (next.endDate < next.startDate) {
      throw new AppError('VALIDATION_ERROR', 'Tanggal selesai harus ≥ tanggal mulai', {
        issues: [{ path: 'endDate', message: 'Tanggal selesai harus ≥ tanggal mulai' }],
      });
    }
    if (next.code !== before.code) {
      const hasTx = store.get('SELECT 1 FROM transactions WHERE event_id = ? LIMIT 1', id);
      if (hasTx) throw new AppError('INVALID_STATE', 'Kode event tidak bisa diubah karena sudah ada transaksi');
      assertCodeFree(store, next.code, id);
    }
    if (next.status === 'active' && before.status !== 'active') assertNoOtherActive(store, id);
    store.run(
      `UPDATE events SET code = ?, name = ?, location = ?, start_date = ?, end_date = ?, status = ?, updated_at = ? WHERE id = ?`,
      next.code,
      next.name,
      next.location,
      next.startDate,
      next.endDate,
      next.status,
      nowIso(),
      id,
    );
    return getEvent(store, id);
  });
  ctx.bus.publish('event', { eventId: event.id });
  return event;
}
