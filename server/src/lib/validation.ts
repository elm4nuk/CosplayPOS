import { z } from 'zod';
import { AppError } from './errors.ts';

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => ({
    path: i.path.map(String).join('.'),
    message: i.message,
  }));
  const first = issues[0];
  const message = first ? `Data tidak valid${first.path ? ` (${first.path})` : ''}: ${first.message}` : 'Data tidak valid';
  throw new AppError('VALIDATION_ERROR', message, { issues });
}

// ---- Skema bersama -------------------------------------------------------

export const idParam = z.object({ id: z.coerce.number().int().positive() });

/** Teks wajib: di-trim, tidak boleh kosong. */
export const text = (max: number) => z.string().trim().min(1, 'Wajib diisi').max(max);

/** Teks opsional: string kosong → null. */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v === null || v === '' ? null : v))
    .optional();

export const rupiah = z.number().int('Harus bilangan bulat rupiah').min(0).max(1_000_000_000);

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Format tanggal YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'Tanggal tidak valid');

export const boolQuery = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .optional()
  .transform((v) => v === true || v === 'true' || v === '1');

export const limitQuery = z.coerce.number().int().min(1).max(200).default(50);
export const cursorQuery = z.coerce.number().int().positive().optional();
