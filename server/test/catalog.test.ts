import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clients, setupCatalog, startServer, type Client, type TestServer } from './helpers.ts';

let s: TestServer;
let admin: Client;
let k1: Client;
beforeEach(async () => {
  s = await startServer();
  ({ admin, k1 } = await clients(s));
});
afterEach(async () => {
  await s.destroy();
});

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
);

describe('event', () => {
  it('membuat, validasi tanggal, maksimal satu event aktif, kode terkunci setelah ada transaksi', async () => {
    const bad = await admin.post('/api/events', { code: 'CF', name: 'X', startDate: '2026-10-18', endDate: '2026-10-17' });
    expect(bad.status).toBe(400);
    const badDate = await admin.post('/api/events', { code: 'CF', name: 'X', startDate: '2026-02-30', endDate: '2026-03-01' });
    expect(badDate.status).toBe(400);

    const a = await admin.post('/api/events', { code: 'cf21', name: 'Comifuro 21', startDate: '2026-10-17', endDate: '2026-10-18', status: 'active' });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ code: 'CF21', status: 'active', location: null });

    const dupe = await admin.post('/api/events', { code: 'CF21', name: 'Lagi', startDate: '2026-10-17', endDate: '2026-10-18' });
    expect(dupe.body.error).toMatchObject({ code: 'DUPLICATE', details: { field: 'code' } });

    const b = await admin.post('/api/events', { code: 'CF22', name: 'Comifuro 22', startDate: '2027-04-01', endDate: '2027-04-02' });
    expect(b.body.status).toBe('planned');
    const conflict = await admin.patch(`/api/events/${b.body.id}`, { status: 'active' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatchObject({ code: 'ANOTHER_EVENT_ACTIVE', details: { activeEventId: a.body.id } });
    const conflictCreate = await admin.post('/api/events', { code: 'CF23', name: 'X', startDate: '2027-04-01', endDate: '2027-04-02', status: 'active' });
    expect(conflictCreate.body.error.code).toBe('ANOTHER_EVENT_ACTIVE');

    expect((await k1.get('/api/events/active')).body.event.id).toBe(a.body.id);
    await admin.patch(`/api/events/${a.body.id}`, { status: 'finished' });
    expect((await k1.get('/api/events/active')).body.event).toBeNull();
    expect((await admin.patch(`/api/events/${b.body.id}`, { status: 'active' })).body.status).toBe('active');
    expect((await k1.get('/api/server-info')).body.activeEvent).toMatchObject({ id: b.body.id, code: 'CF22' });

    // ubah kode sebelum ada transaksi: boleh
    expect((await admin.patch(`/api/events/${b.body.id}`, { code: 'CFX' })).body.code).toBe('CFX');
    const prod = await admin.post('/api/products', { name: 'P', variants: [{ sku: 'P-1', price: 1000, initialStock: 1 }] });
    await k1.post('/api/transactions', {
      clientRequestId: crypto.randomUUID(),
      eventId: b.body.id,
      paymentMethod: 'cash',
      items: [{ variantId: prod.body.variants[0].id, quantity: 1 }],
      amountReceived: 1000,
    });
    const locked = await admin.patch(`/api/events/${b.body.id}`, { code: 'CFY' });
    expect(locked.body.error.code).toBe('INVALID_STATE');
    expect((await admin.patch(`/api/events/${b.body.id}`, { name: 'Nama baru', location: '' })).body).toMatchObject({ name: 'Nama baru', location: null });

    const list = await k1.get('/api/events');
    expect(list.body.items.map((e: { code: string }) => e.code)).toEqual(['CFX', 'CF21']);
  });
});

describe('produk & varian', () => {
  it('membuat produk dengan varian, stok awal tercatat; SKU unik (case-insensitive)', async () => {
    const cat = await admin.post('/api/categories', { name: 'Akrilik' });
    const p = await admin.post('/api/products', {
      name: 'Akrilik Stand',
      categoryId: cat.body.id,
      variants: [
        { name: 'Raiden', sku: 'ACR-RAI', price: 45000, initialStock: 5 },
        { name: 'Nahida', sku: 'ACR-NAH', price: 45000 },
      ],
    });
    expect(p.status).toBe(201);
    expect(p.body).toMatchObject({ name: 'Akrilik Stand', categoryId: cat.body.id, categoryName: 'Akrilik', imageUrl: null, active: true, description: null });
    expect(p.body.variants).toEqual([
      expect.objectContaining({ name: 'Raiden', sku: 'ACR-RAI', price: 45000, stock: 5, active: true, sortOrder: 0 }),
      expect.objectContaining({ name: 'Nahida', sku: 'ACR-NAH', price: 45000, stock: 0, sortOrder: 1 }),
    ]);
    const mv = await admin.get(`/api/stock-movements?productId=${p.body.id}`);
    expect(mv.body.items).toHaveLength(1);
    expect(mv.body.items[0]).toMatchObject({ reason: 'initial', delta: 5, userName: 'Admin' });

    const dup = await admin.post('/api/products', { name: 'X', variants: [{ sku: 'acr-rai', price: 1 }] });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({ code: 'DUPLICATE', details: { field: 'sku' } });
    const dupInReq = await admin.post('/api/products', { name: 'X', variants: [{ sku: 'Z1', price: 1 }, { sku: 'z1', price: 1 }] });
    expect(dupInReq.body.error.code).toBe('DUPLICATE');
    expect((await admin.get('/api/products?includeInactive=true')).body.items).toHaveLength(1); // tidak ada produk setengah jadi

    const noVariants = await admin.post('/api/products', { name: 'X', variants: [] });
    expect(noVariants.status).toBe(400);
    const badPrice = await admin.post('/api/products', { name: 'X', variants: [{ sku: 'Q', price: 1.5 }] });
    expect(badPrice.status).toBe(400);
    const badCat = await admin.post('/api/products', { name: 'X', categoryId: 999, variants: [{ sku: 'Q', price: 1 }] });
    expect(badCat.status).toBe(400);
  });

  it('PATCH varian menolak field stock; tambah varian; nonaktif disembunyikan dari kasir', async () => {
    const c = await setupCatalog(admin, { stock: 5 });
    const withStock = await admin.patch(`/api/variants/${c.variantA.id}`, { stock: 100 });
    expect(withStock.status).toBe(400);
    const withStockProduct = await admin.patch(`/api/products/${c.product.id}`, { stock: 100 });
    expect(withStockProduct.status).toBe(400);

    const added = await admin.post(`/api/products/${c.product.id}/variants`, { name: 'C', sku: 'NEW-C', price: 1000, initialStock: 2 });
    expect(added.status).toBe(201);
    expect(added.body.variants).toHaveLength(3);
    expect(added.body.variants[2]).toMatchObject({ name: 'C', stock: 2, sortOrder: 2 });

    await admin.patch(`/api/variants/${c.variantB.id}`, { active: false });
    const forCashier = await k1.get('/api/products');
    expect(forCashier.body.items[0].variants.map((v: { name: string }) => v.name)).toEqual(['A', 'C']);
    const forAdmin = await admin.get('/api/products?includeInactive=true');
    expect(forAdmin.body.items[0].variants).toHaveLength(3);
    // kasir tidak bisa memaksa includeInactive
    expect((await k1.get('/api/products?includeInactive=true')).body.items[0].variants).toHaveLength(2);

    await admin.patch(`/api/products/${c.product.id}`, { active: false });
    expect((await k1.get('/api/products')).body.items).toHaveLength(0);
    expect((await k1.get(`/api/products/${c.product.id}`)).status).toBe(404);
    expect((await admin.get(`/api/products/${c.product.id}`)).status).toBe(200);
  });

  it('pencarian & filter kategori', async () => {
    const c = await setupCatalog(admin);
    await admin.post('/api/products', { name: 'Poster Besar', variants: [{ name: 'Hoshino', sku: 'PST-100', price: 1 }] });
    expect((await k1.get('/api/products?q=hoshi')).body.items.map((p: { name: string }) => p.name)).toEqual(['Poster Besar']);
    expect((await k1.get('/api/products?q=pst-1')).body.items).toHaveLength(1);
    expect((await k1.get('/api/products?q=%25')).body.items).toHaveLength(0); // wildcard di-escape
    expect((await k1.get(`/api/products?categoryId=${c.category.id}`)).body.items.map((p: { id: number }) => p.id)).toEqual([c.product.id]);
  });

  it('kategori: unik, urutan, ubah', async () => {
    await admin.post('/api/categories', { name: 'Zeta', sortOrder: 0 });
    await admin.post('/api/categories', { name: 'Alpha', sortOrder: 5 });
    expect((await admin.post('/api/categories', { name: 'alpha' })).body.error.code).toBe('DUPLICATE');
    const list = await k1.get('/api/categories');
    expect(list.body.items.map((c: { name: string }) => c.name)).toEqual(['Zeta', 'Alpha']);
    const upd = await admin.patch(`/api/categories/${list.body.items[1].id}`, { sortOrder: -1, active: false });
    expect(upd.body).toMatchObject({ name: 'Alpha', sortOrder: -1, active: false });
  });

  it('gambar produk: upload PNG, URL berubah, ETag, tipe salah ditolak, hapus', async () => {
    const c = await setupCatalog(admin);
    const upload = async (buf: Buffer, type = 'image/png') => {
      const fd = new FormData();
      fd.append('file', new Blob([buf], { type }), 'x.png');
      const res = await fetch(`${s.url}/api/products/${c.product.id}/image`, { method: 'PUT', headers: { authorization: `Bearer ${admin.token}` }, body: fd });
      return { status: res.status, body: await res.json() as any };
    };
    const r1 = await upload(PNG);
    expect(r1.status).toBe(200);
    expect(r1.body.imageUrl).toMatch(new RegExp(`^/api/products/${c.product.id}/image\\?v=\\d+$`));

    const img = await fetch(s.url + r1.body.imageUrl, { headers: { authorization: `Bearer ${k1.token}` } });
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await img.arrayBuffer()).equals(PNG)).toBe(true);
    const etag = img.headers.get('etag')!;
    const cached = await fetch(s.url + r1.body.imageUrl, { headers: { authorization: `Bearer ${k1.token}`, 'if-none-match': etag } });
    expect(cached.status).toBe(304);

    const r2 = await upload(PNG);
    expect(r2.body.imageUrl).not.toBe(r1.body.imageUrl);

    const bad = await upload(Buffer.from('bukan gambar'), 'image/png');
    expect(bad.status).toBe(415);
    expect(bad.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');

    const tooBig = await upload(Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]));
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error.code).toBe('PAYLOAD_TOO_LARGE');

    const del = await admin.req('DELETE', `/api/products/${c.product.id}/image`);
    expect(del.body.imageUrl).toBeNull();
    expect((await k1.get(`/api/products/${c.product.id}/image`)).status).toBe(404);
  });
});

describe('penyesuaian stok', () => {
  it('delta, setTo, expectedStock, negatif, nol — semua tercatat', async () => {
    const c = await setupCatalog(admin, { stock: 5 });
    const url = `/api/variants/${c.variantA.id}/stock-adjustments`;

    const restock = await admin.post(url, { delta: 10, reason: 'restock', note: 'Kiriman hari 2' });
    expect(restock.status).toBe(201);
    expect(restock.body.variant.stock).toBe(15);
    expect(restock.body.movement).toMatchObject({ delta: 10, stockAfter: 15, reason: 'restock', note: 'Kiriman hari 2', eventId: c.event.id });

    const stale = await admin.post(url, { setTo: 4, expectedStock: 5, reason: 'correction' });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'STOCK_CHANGED', details: { currentStock: 15 } });

    const set = await admin.post(url, { setTo: 4, expectedStock: 15, reason: 'correction' });
    expect(set.body.movement).toMatchObject({ delta: -11, stockAfter: 4 });

    const neg = await admin.post(url, { delta: -5, reason: 'damaged' });
    expect(neg.status).toBe(409);
    expect(neg.body.error.code).toBe('NEGATIVE_STOCK');

    expect((await admin.post(url, { delta: 0, reason: 'other' })).status).toBe(400);
    expect((await admin.post(url, { setTo: 4, reason: 'other' })).status).toBe(400);
    expect((await admin.post(url, { delta: 1, setTo: 1, reason: 'other' })).status).toBe(400);
    expect((await admin.post(url, { delta: 1, reason: 'sale' })).status).toBe(400); // 'sale' hanya dari checkout
    expect((await admin.post('/api/variants/99999/stock-adjustments', { delta: 1, reason: 'restock' })).status).toBe(404);

    const mv = await admin.get(`/api/stock-movements?variantId=${c.variantA.id}&limit=2`);
    expect(mv.body.items.map((m: { reason: string }) => m.reason)).toEqual(['correction', 'restock']);
    expect(mv.body.nextCursor).not.toBeNull();
    const rest = await admin.get(`/api/stock-movements?variantId=${c.variantA.id}&limit=2&before=${mv.body.nextCursor}`);
    expect(rest.body.items.map((m: { reason: string }) => m.reason)).toEqual(['initial']);
    expect(rest.body.nextCursor).toBeNull();
  });
});

describe('pengaturan', () => {
  it('kasir boleh baca, admin ubah; string kosong → null; timezone read-only', async () => {
    expect((await k1.get('/api/settings')).body).toMatchObject({ storeName: 'Booth Cosplay', lowStockThreshold: 3, timezone: 'Asia/Jakarta' });
    const r = await admin.patch('/api/settings', { storeName: 'Booth Kece', storeAddress: '', lowStockThreshold: 5, timezone: 'UTC' });
    expect(r.body).toMatchObject({ storeName: 'Booth Kece', storeAddress: null, lowStockThreshold: 5, timezone: 'Asia/Jakarta' });
    expect((await admin.patch('/api/settings', { storeName: '' })).status).toBe(400);
  });
});
