import type { AuthInfo, Ctx, Role } from '../context.ts';
import { AppError } from '../lib/errors.ts';
import { getDummyHash, hashPassword, newToken, sha256, verifyPassword } from '../lib/password.ts';
import { nowIso } from '../lib/time.ts';
import { getUser, revokeSessions, type User } from './users.ts';

const MAX_FAILS = 10;
const WINDOW_MS = 5 * 60_000;
const TOUCH_INTERVAL_MS = 60_000;

/** Pembatas login gagal per (username, IP), di memori. */
export class LoginLimiter {
  #fails = new Map<string, { count: number; first: number }>();

  check(key: string): void {
    const entry = this.#fails.get(key);
    if (!entry) return;
    const elapsed = Date.now() - entry.first;
    if (elapsed > WINDOW_MS) {
      this.#fails.delete(key);
      return;
    }
    if (entry.count >= MAX_FAILS) {
      const retryAfterSeconds = Math.ceil((WINDOW_MS - elapsed) / 1000);
      throw new AppError('TOO_MANY_ATTEMPTS', `Terlalu banyak percobaan login. Coba lagi dalam ${retryAfterSeconds} detik.`, {
        retryAfterSeconds,
      });
    }
  }

  fail(key: string): void {
    const now = Date.now();
    const entry = this.#fails.get(key);
    if (!entry || now - entry.first > WINDOW_MS) this.#fails.set(key, { count: 1, first: now });
    else entry.count++;
    if (this.#fails.size > 10_000) this.#fails.clear(); // batas memori sederhana
  }

  reset(key: string): void {
    this.#fails.delete(key);
  }
}

interface LoginRow {
  id: number;
  password_hash: string;
  active: number;
}

export interface LoginResult {
  token: string;
  expiresAt: string;
  user: User;
}

export async function login(
  ctx: Ctx,
  limiter: LoginLimiter,
  input: { username: string; password: string },
  meta: { ip: string; userAgent: string | null },
): Promise<LoginResult> {
  const username = input.username.trim().toLowerCase();
  const key = `${username}|${meta.ip}`;
  limiter.check(key);

  const row = ctx.store.get<LoginRow>('SELECT id, password_hash, active FROM users WHERE username = ?', username);
  const ok = await verifyPassword(input.password, row?.password_hash ?? (await getDummyHash()));
  if (!row || !ok || row.active !== 1) {
    limiter.fail(key);
    throw new AppError('INVALID_CREDENTIALS', 'Username atau password salah');
  }
  limiter.reset(key);

  // Pengguna bisa saja dinonaktifkan selama verifikasi async; cek ulang saat menulis sesi.
  const token = newToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ctx.config.sessionHours * 3_600_000).toISOString();
  ctx.store.tx(() => {
    const fresh = ctx.store.get<{ active: number; password_hash: string }>('SELECT active, password_hash FROM users WHERE id = ?', row.id);
    if (!fresh || fresh.active !== 1 || fresh.password_hash !== row.password_hash) {
      throw new AppError('INVALID_CREDENTIALS', 'Username atau password salah');
    }
    ctx.store.run(
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
      sha256(token),
      row.id,
      now.toISOString(),
      expiresAt,
      now.toISOString(),
      meta.ip,
      meta.userAgent?.slice(0, 300) ?? null,
    );
    // Bersihkan sesi kedaluwarsa sesekali.
    ctx.store.run('DELETE FROM sessions WHERE expires_at <= ?', now.toISOString());
  });
  return { token, expiresAt, user: getUser(ctx.store, row.id) };
}

interface SessionRow {
  session_id: number;
  expires_at: string;
  last_seen_at: string;
  user_id: number;
  username: string;
  display_name: string;
  role: Role;
}

export function authenticate(ctx: Ctx, token: string): AuthInfo | null {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const now = nowIso();
  const row = ctx.store.get<SessionRow>(
    `SELECT s.id AS session_id, s.expires_at, s.last_seen_at, u.id AS user_id, u.username, u.display_name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
    sha256(token),
    now,
  );
  if (!row) return null;
  if (Date.now() - Date.parse(row.last_seen_at) > TOUCH_INTERVAL_MS) {
    ctx.store.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', now, row.session_id);
  }
  return {
    sessionId: row.session_id,
    expiresAt: row.expires_at,
    user: { id: row.user_id, username: row.username, displayName: row.display_name, role: row.role },
  };
}

export function logout(ctx: Ctx, sessionId: number): void {
  ctx.store.run('DELETE FROM sessions WHERE id = ?', sessionId);
}

export async function changePassword(
  ctx: Ctx,
  auth: AuthInfo,
  input: { currentPassword: string; newPassword: string },
): Promise<void> {
  const row = ctx.store.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', auth.user.id);
  if (!row || !(await verifyPassword(input.currentPassword, row.password_hash))) {
    throw new AppError('INVALID_CREDENTIALS', 'Password saat ini salah');
  }
  const hash = await hashPassword(input.newPassword);
  ctx.store.tx(() => {
    ctx.store.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hash, nowIso(), auth.user.id);
    revokeSessions(ctx, auth.user.id, auth.sessionId);
  });
}
