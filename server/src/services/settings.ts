import { z } from 'zod';
import type { Ctx } from '../context.ts';
import type { Store } from '../db/store.ts';
import { optionalText, text } from '../lib/validation.ts';

export interface Settings {
  storeName: string;
  storeAddress: string | null;
  storePhone: string | null;
  receiptHeader: string | null;
  receiptFooter: string | null;
  lowStockThreshold: number;
  timezone: string;
}

type StoredSettings = Omit<Settings, 'timezone'>;

const DEFAULTS: StoredSettings = {
  storeName: 'Booth Cosplay',
  storeAddress: null,
  storePhone: null,
  receiptHeader: null,
  receiptFooter: 'Terima kasih!',
  lowStockThreshold: 3,
};

export const updateSettingsSchema = z.object({
  storeName: text(60).optional(),
  storeAddress: optionalText(200),
  storePhone: optionalText(40),
  receiptHeader: optionalText(300),
  receiptFooter: optionalText(300),
  lowStockThreshold: z.number().int().min(0).max(10_000).optional(),
});

export function getSettings(store: Store, timezone: string): Settings {
  const out: Record<string, unknown> = { ...DEFAULTS };
  for (const row of store.all<{ key: string; value: string }>('SELECT key, value FROM settings')) {
    if (row.key in DEFAULTS) out[row.key] = JSON.parse(row.value);
  }
  return { ...(out as StoredSettings), timezone };
}

export function updateSettings(ctx: Ctx, input: z.output<typeof updateSettingsSchema>): Settings {
  ctx.store.tx(() => {
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined || !(key in DEFAULTS)) continue;
      ctx.store.run(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        key,
        JSON.stringify(value),
      );
    }
  });
  return getSettings(ctx.store, ctx.config.timezone);
}
