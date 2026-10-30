import { z } from 'zod';
import type { Ctx, Role } from '../context.ts';
import { toBool, type Store } from '../db/store.ts';
import { AppError, notFound, rethrowUnique } from '../lib/errors.ts';
import { hashPassword } from '../lib/password.ts';
import { nowIso } from '../lib/time.ts';
import { text } from '../lib/validation.ts';

export interface User {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  active: boolean;
  createdAt: string;
}

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  active: number;
  created_at: string;
}

const COLS = 'id, username, display_name, role, active, created_at';

export const toUser = (r: UserRow): User => ({
  id: r.id,
  username: r.username,
  displayName: r.display_name,
  role: r.role,
  active: toBool(r.active),
  createdAt: r.created_at,
});

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{3,32}$/, 'Username 3–32 karakter: huruf kecil, angka, titik, garis bawah, strip');
export const passwordSchema = z.string().min(6, 'Password minimal 6 karakter').max(200);
const roleSchema = z.enum(['admin', 'cashier']);

export const createUserSchema = z.object({
  username: usernameSchema,
  displayName: text(60),
  password: passwordSchema,
  role: roleSchema,
});

export const updateUserSchema = z.object({
  displayName: text(60).optional(),
  role: roleSchema.optional(),
  active: z.boolean().optional(),
  password: passwordSchema.optional(),
});

export function listUsers(ctx: Ctx): User[] {
  return ctx.store.all<UserRow>(`SELECT ${COLS} FROM users ORDER BY role, username`).map(toUser);
}

export function getUser(store: Store, id: number): User {
  const row = store.get<UserRow>(`SELECT ${COLS} FROM users WHERE id = ?`, id);
  if (!row) throw notFound('User');
  return toUser(row);
}

export async function createUser(ctx: Ctx, input: z.output<typeof createUserSchema>): Promise<User> {
  const hash = await hashPassword(input.password);
  const now = nowIso();
  try {
    const r = ctx.store.run(
      'INSERT INTO users (username, display_name, password_hash, role, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      input.username,
      input.displayName,
      hash,
      input.role,
      now,
      now,
    );
    return getUser(ctx.store, Number(r.lastInsertRowid));
  } catch (err) {
    rethrowUnique(err, 'username', `Username "${input.username}" sudah dipakai`);
  }
}

export function revokeSessions(ctx: Ctx, userId: number, exceptSessionId?: number): void {
  if (exceptSessionId) ctx.store.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', userId, exceptSessionId);
  else {
    ctx.store.run('DELETE FROM sessions WHERE user_id = ?', userId);
    ctx.bus.disconnectUser(userId);
  }
}

export async function updateUser(ctx: Ctx, id: number, input: z.output<typeof updateUserSchema>): Promise<User> {
  // Hash dihitung di luar transaksi (async); sisanya sinkron & atomik.
  const hash = input.password !== undefined ? await hashPassword(input.password) : undefined;
  const { store } = ctx;
  let revoke = false;
  store.tx(() => {
    const before = getUser(store, id);
    const demoting = before.role === 'admin' && input.role !== undefined && input.role !== 'admin';
    const deactivating = before.role === 'admin' && before.active && input.active === false;
    if ((demoting || deactivating) && before.active) {
      const admins = store.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1")!.n;
      if (admins <= 1) throw new AppError('LAST_ADMIN', 'Tidak bisa menonaktifkan atau menurunkan admin aktif terakhir');
    }
    const now = nowIso();
    if (input.displayName !== undefined) store.run('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?', input.displayName, now, id);
    if (input.role !== undefined && input.role !== before.role) {
      store.run('UPDATE users SET role = ?, updated_at = ? WHERE id = ?', input.role, now, id);
      revoke = true;
    }
    if (input.active !== undefined && input.active !== before.active) {
      store.run('UPDATE users SET active = ?, updated_at = ? WHERE id = ?', input.active ? 1 : 0, now, id);
      if (!input.active) revoke = true;
    }
    if (hash !== undefined) {
      store.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hash, now, id);
      revoke = true;
    }
    if (revoke) store.run('DELETE FROM sessions WHERE user_id = ?', id);
  });
  if (revoke) ctx.bus.disconnectUser(id);
  return getUser(store, id);
}

/** Buat admin awal jika belum ada user sama sekali. Mengembalikan true jika dibuat. */
export async function ensureInitialAdmin(ctx: Ctx): Promise<boolean> {
  const n = ctx.store.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
  if (n > 0) return false;
  await createUser(ctx, { username: 'admin', displayName: 'Admin', password: ctx.config.initialAdminPassword, role: 'admin' });
  return true;
}
