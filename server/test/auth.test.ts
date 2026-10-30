import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, clients, startServer, type TestServer } from './helpers.ts';

let s: TestServer;
beforeEach(async () => {
  s = await startServer();
});
afterEach(async () => {
  await s.destroy();
});

describe('auth', () => {
  it('login mengembalikan token + cookie HttpOnly; /me bekerja dengan bearer maupun cookie', async () => {
    const res = await fetch(`${s.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'KASIR1', password: 'kasir123' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.user).toMatchObject({ username: 'kasir1', role: 'cashier', active: true });
    expect(body.user).not.toHaveProperty('passwordHash');
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/pos_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const viaCookie = await fetch(`${s.url}/api/auth/me`, { headers: { cookie: cookie.split(';')[0]! } });
    expect(viaCookie.status).toBe(200);
    expect((await viaCookie.json() as any).user.username).toBe('kasir1');

    const c = new Client(s.url);
    c.token = body.token;
    expect((await c.get('/api/auth/me')).body.user.username).toBe('kasir1');
  });

  it('kredensial salah → 401 INVALID_CREDENTIALS (username tidak ada maupun password salah)', async () => {
    const c = new Client(s.url);
    const a = await c.post('/api/auth/login', { username: 'kasir1', password: 'salah' });
    const b = await c.post('/api/auth/login', { username: 'tidakada', password: 'salah' });
    expect(a.status).toBe(401);
    expect(a.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(b.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it('endpoint non-publik tanpa sesi → 401 UNAUTHENTICATED; publik tetap bisa', async () => {
    const c = new Client(s.url);
    for (const url of ['/api/products', '/api/events', '/api/transactions', '/api/settings', '/api/users', '/api/stream']) {
      const r = await c.get(url);
      expect(r.status, url).toBe(401);
      expect(r.body.error.code).toBe('UNAUTHENTICATED');
    }
    expect((await c.get('/api/health')).status).toBe(200);
    expect((await c.get('/api/server-info')).status).toBe(200);
    c.token = 'f'.repeat(64);
    expect((await c.get('/api/products')).status).toBe(401);
  });

  it('kasir dilarang ke endpoint admin (403), admin boleh', async () => {
    const { admin, k1 } = await clients(s);
    const adminOnly: [string, string, unknown?][] = [
      ['GET', '/api/users'],
      ['POST', '/api/users', { username: 'x1', displayName: 'X', password: 'xxxxxx', role: 'cashier' }],
      ['POST', '/api/events', { code: 'AA', name: 'A', startDate: '2026-01-01', endDate: '2026-01-01' }],
      ['POST', '/api/categories', { name: 'K' }],
      ['POST', '/api/products', { name: 'P', variants: [{ sku: 'P1', price: 1 }] }],
      ['GET', '/api/stock-movements'],
      ['PATCH', '/api/settings', { storeName: 'X' }],
      ['GET', '/api/admin/backups'],
      ['POST', '/api/admin/backups', {}],
      ['POST', '/api/admin/restore', { name: 'x' }],
      ['GET', '/api/reports/events/1/summary'],
      ['GET', '/api/reports/events/1/export.csv'],
    ];
    for (const [m, url, body] of adminOnly) {
      const r = await k1.req(m, url, body);
      expect(r.status, `${m} ${url}`).toBe(403);
      expect(r.body.error.code).toBe('FORBIDDEN');
    }
    expect((await admin.get('/api/users')).status).toBe(200);
  });

  it('logout mencabut sesi', async () => {
    const { k1 } = await clients(s);
    expect((await k1.post('/api/auth/logout')).status).toBe(204);
    expect((await k1.get('/api/auth/me')).status).toBe(401);
  });

  it('logout tanpa body dan tanpa content-type tetap 204', async () => {
    const { k1 } = await clients(s);
    const res = await fetch(`${s.url}/api/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${k1.token}` } });
    expect(res.status).toBe(204);
  });

  it('satu user bisa login di beberapa perangkat sekaligus', async () => {
    const hp = await new Client(s.url).login('kasir1', 'kasir123');
    const tablet = await new Client(s.url).login('kasir1', 'kasir123');
    expect((await hp.get('/api/auth/me')).status).toBe(200);
    expect((await tablet.get('/api/auth/me')).status).toBe(200);
  });

  it('menonaktifkan user / ganti password oleh admin mencabut semua sesinya', async () => {
    const { admin, k1, k2 } = await clients(s);
    const users = (await admin.get('/api/users')).body.items;
    const kasir1 = users.find((u: { username: string }) => u.username === 'kasir1');
    const kasir2 = users.find((u: { username: string }) => u.username === 'kasir2');

    expect((await admin.patch(`/api/users/${kasir1.id}`, { active: false })).body.active).toBe(false);
    expect((await k1.get('/api/auth/me')).status).toBe(401);
    expect((await new Client(s.url).post('/api/auth/login', { username: 'kasir1', password: 'kasir123' })).status).toBe(401);

    await admin.patch(`/api/users/${kasir2.id}`, { password: 'barubaru' });
    expect((await k2.get('/api/auth/me')).status).toBe(401);
    await new Client(s.url).login('kasir2', 'barubaru');
  });

  it('ganti password sendiri: sesi lain dicabut, sesi saat ini tetap', async () => {
    const a = await new Client(s.url).login('kasir1', 'kasir123');
    const b = await new Client(s.url).login('kasir1', 'kasir123');
    expect((await a.post('/api/auth/change-password', { currentPassword: 'salah', newPassword: 'abcdef' })).status).toBe(401);
    expect((await a.post('/api/auth/change-password', { currentPassword: 'kasir123', newPassword: 'abc' })).status).toBe(400);
    expect((await a.post('/api/auth/change-password', { currentPassword: 'kasir123', newPassword: 'abcdef' })).status).toBe(204);
    expect((await a.get('/api/auth/me')).status).toBe(200);
    expect((await b.get('/api/auth/me')).status).toBe(401);
    await new Client(s.url).login('kasir1', 'abcdef');
  });

  it('admin aktif terakhir tidak bisa dinonaktifkan atau diturunkan', async () => {
    const { admin } = await clients(s);
    const me = (await admin.get('/api/auth/me')).body.user;
    const r1 = await admin.patch(`/api/users/${me.id}`, { active: false });
    expect(r1.status).toBe(409);
    expect(r1.body.error.code).toBe('LAST_ADMIN');
    expect((await admin.patch(`/api/users/${me.id}`, { role: 'cashier' })).body.error.code).toBe('LAST_ADMIN');

    const second = await admin.post('/api/users', { username: 'admin2', displayName: 'Admin 2', password: 'admin2pass', role: 'admin' });
    expect(second.status).toBe(201);
    expect((await admin.patch(`/api/users/${second.body.id}`, { active: false })).status).toBe(200);
  });

  it('username duplikat → 409 DUPLICATE; validasi username', async () => {
    const { admin } = await clients(s);
    const dup = await admin.post('/api/users', { username: 'Kasir1', displayName: 'X', password: 'xxxxxx', role: 'cashier' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({ code: 'DUPLICATE', details: { field: 'username' } });
    const bad = await admin.post('/api/users', { username: 'a b', displayName: 'X', password: 'xxxxxx', role: 'cashier' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.issues[0].path).toBe('username');
  });

  it('login gagal berulang → 429 TOO_MANY_ATTEMPTS', async () => {
    const c = new Client(s.url);
    for (let i = 0; i < 10; i++) expect((await c.post('/api/auth/login', { username: 'kasir1', password: 'x' })).status).toBe(401);
    const blocked = await c.post('/api/auth/login', { username: 'kasir1', password: 'kasir123' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_ATTEMPTS');
    expect(blocked.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    // user lain tidak terpengaruh
    expect((await c.post('/api/auth/login', { username: 'kasir2', password: 'kasir123' })).status).toBe(200);
  });

  it('JSON rusak → 400, content-type salah → 415, endpoint tidak ada → 404 JSON', async () => {
    const { k1 } = await clients(s);
    const bad = await fetch(`${s.url}/api/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${k1.token}` },
      body: '{bukan json',
    });
    expect(bad.status).toBe(400);
    expect((await bad.json() as any).error.code).toBe('VALIDATION_ERROR');

    const form = await fetch(`${s.url}/api/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', authorization: `Bearer ${k1.token}` },
      body: 'x',
    });
    expect(form.status).toBe(415);
    expect((await form.json() as any).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');

    const nf = await k1.get('/api/tidak-ada');
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe('NOT_FOUND');
  });
});
