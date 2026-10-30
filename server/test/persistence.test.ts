import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, clients, rid, setupCatalog, startServer, tempDataDir, type TestServer } from './helpers.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe('persistensi', () => {
  it('restart server tidak menghapus data (transaksi, stok, user, sesi)', async () => {
    const dataDir = tempDataDir();
    cleanup.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));

    const s1 = await startServer({ dataDir });
    const { admin, k1 } = await clients(s1);
    const c = await setupCatalog(admin, { stock: 3 });
    const r = await k1.post('/api/transactions', {
      clientRequestId: rid(),
      eventId: c.event.id,
      paymentMethod: 'cash',
      items: [{ variantId: c.variantA.id, quantity: 1 }],
      amountReceived: 50000,
    });
    expect(r.status).toBe(201);
    await s1.stop();

    const s2 = await startServer({ dataDir });
    cleanup.push(() => s2.stop());
    const k1b = new Client(s2.url);
    k1b.token = k1.token; // sesi lama masih berlaku setelah restart
    expect((await k1b.get('/api/auth/me')).status).toBe(200);
    expect((await k1b.get(`/api/transactions/${r.body.transaction.number}`)).body.total).toBe(45000);
    expect((await k1b.get(`/api/products/${c.product.id}`)).body.variants[0].stock).toBe(2);
    expect((await k1b.get('/api/events/active')).body.event.id).toBe(c.event.id);
    // nomor transaksi berlanjut
    const r2 = await k1b.post('/api/transactions', {
      clientRequestId: rid(),
      eventId: c.event.id,
      paymentMethod: 'cash',
      items: [{ variantId: c.variantA.id, quantity: 1 }],
      amountReceived: 50000,
    });
    expect(r2.body.transaction.number).toMatch(/-0002$/);
  });

  it('database memakai WAL + synchronous FULL + foreign keys', async () => {
    const s = await startServer();
    cleanup.push(() => s.destroy());
    const q = (sql: string) => Object.values(s.ctx.store.get<Record<string, unknown>>(sql)!)[0];
    expect(q('PRAGMA journal_mode')).toBe('wal');
    expect(q('PRAGMA synchronous')).toBe(2);
    expect(q('PRAGMA foreign_keys')).toBe(1);
    expect(fs.existsSync(path.join(s.dataDir, 'pos.db'))).toBe(true);
  });

  it('constraint database menolak stok negatif walau ada bug di aplikasi', async () => {
    const s = await startServer();
    cleanup.push(() => s.destroy());
    const { admin } = await clients(s);
    const c = await setupCatalog(admin, { stock: 1 });
    expect(() => s.ctx.store.run('UPDATE product_variants SET stock = -1 WHERE id = ?', c.variantA.id)).toThrow(/CHECK constraint/);
  });
});

describe('backup & restore', () => {
  let s: TestServer;
  afterEach(async () => {
    await s?.destroy();
  });

  it('backup manual → ubah data → restore by name → data kembali, sesi dicabut, pre-restore dibuat', async () => {
    s = await startServer();
    const { admin, k1 } = await clients(s);
    const c = await setupCatalog(admin, { stock: 5 });

    const b = await admin.post('/api/admin/backups');
    expect(b.status).toBe(201);
    expect(b.body).toMatchObject({ kind: 'manual' });
    expect(b.body.name).toMatch(/^pos-.*-manual\.db$/);
    expect(b.body.sizeBytes).toBeGreaterThan(0);

    await k1.post('/api/transactions', {
      clientRequestId: rid(),
      eventId: c.event.id,
      paymentMethod: 'cash',
      items: [{ variantId: c.variantA.id, quantity: 5 }],
      amountReceived: 1_000_000,
    });
    expect((await admin.get(`/api/products/${c.product.id}`)).body.variants[0].stock).toBe(0);

    const list = await admin.get('/api/admin/backups');
    expect(list.body.items.map((x: { name: string }) => x.name)).toContain(b.body.name);
    expect(list.body.directory).toBe(s.ctx.config.backupDir);

    const dl = await fetch(`${s.url}/api/admin/backups/${b.body.name}/download`, { headers: { authorization: `Bearer ${admin.token}` } });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toContain(b.body.name);
    expect(Buffer.from(await dl.arrayBuffer()).subarray(0, 15).toString()).toBe('SQLite format 3');

    const restored = await admin.post('/api/admin/restore', { name: b.body.name });
    expect(restored.status).toBe(200);
    expect(restored.body.restoredFrom).toBe(b.body.name);
    expect(restored.body.preRestoreBackup.kind).toBe('pre-restore');

    // semua sesi dicabut
    expect((await admin.get('/api/auth/me')).status).toBe(401);
    expect((await k1.get('/api/auth/me')).status).toBe(401);
    const admin2 = await new Client(s.url).login('admin', 'admin123');
    expect((await admin2.get(`/api/products/${c.product.id}`)).body.variants[0].stock).toBe(5);
    expect((await admin2.get('/api/transactions')).body.items).toHaveLength(0);

    // pre-restore berisi data sesudah transaksi → bisa dipulihkan kembali
    const back = await admin2.post('/api/admin/restore', { name: restored.body.preRestoreBackup.name });
    expect(back.status).toBe(200);
    const admin3 = await new Client(s.url).login('admin', 'admin123');
    expect((await admin3.get('/api/transactions')).body.items).toHaveLength(1);
  });

  it('restore via upload multipart; file tidak valid → 422 INVALID_BACKUP dan database lama tetap jalan', async () => {
    s = await startServer();
    const { admin } = await clients(s);
    await setupCatalog(admin);
    const b = (await admin.post('/api/admin/backups')).body;
    const bytes = fs.readFileSync(path.join(s.ctx.config.backupDir, b.name));

    const send = async (buf: Buffer, name = 'backup.db') => {
      const fd = new FormData();
      fd.append('file', new Blob([buf]), name);
      const res = await fetch(`${s.url}/api/admin/restore`, { method: 'POST', headers: { authorization: `Bearer ${admin.token}` }, body: fd });
      return { status: res.status, body: await res.json() as any };
    };

    const junk = await send(Buffer.from('ini bukan database'));
    expect(junk.status).toBe(422);
    expect(junk.body.error.code).toBe('INVALID_BACKUP');

    // SQLite valid tapi bukan database aplikasi ini
    const { DatabaseSync } = await import('node:sqlite');
    const foreignPath = path.join(s.dataDir, 'foreign.db');
    const foreign = new DatabaseSync(foreignPath);
    foreign.exec('CREATE TABLE x (a)');
    foreign.close();
    const other = await send(fs.readFileSync(foreignPath));
    expect(other.status).toBe(422);

    // Masih berfungsi setelah upload gagal
    expect((await admin.get('/api/auth/me')).status).toBe(200);

    const ok = await send(bytes, 'pos-backup.db');
    expect(ok.status).toBe(200);
    expect(ok.body.restoredFrom).toBe('pos-backup.db');
    const fresh = await new Client(s.url).login('admin', 'admin123');
    expect((await fresh.get('/api/products')).body.items).toHaveLength(1);
    // file upload sementara dibersihkan
    expect(fs.readdirSync(s.ctx.config.backupDir).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('nama backup dengan path traversal ditolak', async () => {
    s = await startServer();
    const { admin } = await clients(s);
    expect((await admin.get('/api/admin/backups/..%2F..%2Fpos.db/download')).status).toBe(404);
    expect((await admin.post('/api/admin/restore', { name: '../pos.db' })).status).toBe(404);
  });

  it('backup otomatis dipangkas sesuai POS_AUTO_BACKUP_KEEP dan disalin ke folder mirror', async () => {
    const mirror = tempDataDir();
    s = await startServer({ config: { autoBackupKeep: 2, backupMirrorDir: mirror } });
    const { createBackup } = await import('../src/services/backup.ts');
    for (let i = 0; i < 4; i++) createBackup(s.ctx, 'auto');
    createBackup(s.ctx, 'manual');
    const files = fs.readdirSync(s.ctx.config.backupDir);
    expect(files.filter((f) => f.endsWith('-auto.db'))).toHaveLength(2);
    expect(files.filter((f) => f.endsWith('-manual.db'))).toHaveLength(1);
    expect(fs.readdirSync(mirror).length).toBe(5); // mirror menyimpan semua
    fs.rmSync(mirror, { recursive: true, force: true });
  });
});
