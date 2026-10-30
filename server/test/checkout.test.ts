import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clients, rid, setupCatalog, startServer, type Client, type TestServer } from './helpers.ts';

let s: TestServer;
let admin: Client;
let k1: Client;
let k2: Client;

beforeEach(async () => {
  s = await startServer();
  ({ admin, k1, k2 } = await clients(s));
});
afterEach(async () => {
  await s.destroy();
});

const cash = (eventId: number, items: { variantId: number; quantity: number }[], amountReceived: number, extra: object = {}) => ({
  clientRequestId: rid(),
  eventId,
  paymentMethod: 'cash',
  items,
  amountReceived,
  ...extra,
});

describe('checkout', () => {
  it('mencatat transaksi tunai, menghitung kembalian, mengurangi stok, dan mencatat riwayat stok', async () => {
    const c = await setupCatalog(admin, { stock: 5, price: 45000 });
    const r = await k1.post(
      '/api/transactions',
      cash(c.event.id, [{ variantId: c.variantA.id, quantity: 2 }, { variantId: c.variantB.id, quantity: 1 }], 120000, { expectedTotal: 110000 }),
    );
    expect(r.status).toBe(201);
    const t = r.body.transaction;
    expect(r.body.replayed).toBe(false);
    expect(t.number).toMatch(/^EV\d+-0001$/);
    expect(t.total).toBe(110000);
    expect(t.subtotal).toBe(110000);
    expect(t.amountReceived).toBe(120000);
    expect(t.change).toBe(10000);
    expect(t.itemCount).toBe(3);
    expect(t.cashier.displayName).toBe('Kasir 1');
    expect(t.eventId).toBe(c.event.id);
    expect(t.items).toHaveLength(2);
    expect(t.items[0]).toMatchObject({ productName: c.product.name, variantName: 'A', unitPrice: 45000, quantity: 2, lineTotal: 90000 });
    expect(t.items[0].categoryName).toBe(c.category.name);

    const p = await admin.get(`/api/products/${c.product.id}`);
    expect(p.body.variants[0].stock).toBe(3);
    expect(p.body.variants[1].stock).toBe(9);

    const mv = await admin.get(`/api/stock-movements?variantId=${c.variantA.id}`);
    expect(mv.body.items[0]).toMatchObject({ reason: 'sale', delta: -2, stockAfter: 3, transactionNumber: t.number, eventId: c.event.id });
    expect(mv.body.items[1]).toMatchObject({ reason: 'initial', delta: 5, stockAfter: 5 });

    const second = await k2.post('/api/transactions', cash(c.event.id, [{ variantId: c.variantA.id, quantity: 1 }], 45000));
    expect(second.body.transaction.number).toMatch(/-0002$/);
  });

  it('QRIS wajib konfirmasi manual; amountReceived = total, kembalian 0', async () => {
    const c = await setupCatalog(admin);
    const base = { clientRequestId: rid(), eventId: c.event.id, paymentMethod: 'qris', items: [{ variantId: c.variantA.id, quantity: 1 }] };
    const noConfirm = await k1.post('/api/transactions', base);
    expect(noConfirm.status).toBe(400);
    expect(noConfirm.body.error.code).toBe('VALIDATION_ERROR');

    const ok = await k1.post('/api/transactions', { ...base, qrisConfirmed: true, qrisReference: 'BCA 1234', amountReceived: 999999 });
    expect(ok.status).toBe(201);
    expect(ok.body.transaction).toMatchObject({ paymentMethod: 'qris', total: 45000, amountReceived: 45000, change: 0, qrisReference: 'BCA 1234' });
  });

  it('menolak uang kurang, harga berubah, event tidak aktif, produk nonaktif — tanpa mengubah stok', async () => {
    const c = await setupCatalog(admin, { stock: 5, price: 45000 });
    const items = [{ variantId: c.variantA.id, quantity: 1 }];

    const lowPay = await k1.post('/api/transactions', cash(c.event.id, items, 10000));
    expect(lowPay.status).toBe(422);
    expect(lowPay.body.error).toMatchObject({ code: 'INSUFFICIENT_PAYMENT', details: { total: 45000, amountReceived: 10000 } });

    const priceChanged = await k1.post('/api/transactions', cash(c.event.id, items, 50000, { expectedTotal: 40000 }));
    expect(priceChanged.status).toBe(409);
    expect(priceChanged.body.error).toMatchObject({ code: 'PRICE_CHANGED', details: { expectedTotal: 40000, actualTotal: 45000 } });

    const missingCash = await k1.post('/api/transactions', { ...cash(c.event.id, items, 0), amountReceived: undefined });
    expect(missingCash.status).toBe(400);

    await admin.patch(`/api/variants/${c.variantA.id}`, { active: false });
    const inactive = await k1.post('/api/transactions', cash(c.event.id, items, 50000));
    expect(inactive.status).toBe(409);
    expect(inactive.body.error).toMatchObject({ code: 'PRODUCT_UNAVAILABLE', details: { variantIds: [c.variantA.id] } });
    await admin.patch(`/api/variants/${c.variantA.id}`, { active: true });

    await admin.patch(`/api/events/${c.event.id}`, { status: 'finished' });
    const closed = await k1.post('/api/transactions', cash(c.event.id, items, 50000));
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe('EVENT_NOT_ACTIVE');

    const p = await admin.get(`/api/products/${c.product.id}`);
    expect(p.body.variants[0].stock).toBe(5);
    const txs = await admin.get('/api/transactions');
    expect(txs.body.items).toHaveLength(0);
  });

  it('stok kurang → 409 INSUFFICIENT_STOCK dengan rincian semua item yang kurang, tidak ada yang tersimpan', async () => {
    const c = await setupCatalog(admin, { stock: 1 });
    const r = await k1.post(
      '/api/transactions',
      cash(c.event.id, [{ variantId: c.variantA.id, quantity: 2 }, { variantId: c.variantB.id, quantity: 11 }], 10_000_000),
    );
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(r.body.error.details.items).toEqual([
      expect.objectContaining({ variantId: c.variantA.id, requested: 2, available: 1 }),
      expect.objectContaining({ variantId: c.variantB.id, requested: 11, available: 10 }),
    ]);
    const p = await admin.get(`/api/products/${c.product.id}`);
    expect(p.body.variants.map((v: { stock: number }) => v.stock)).toEqual([1, 10]);
  });

  it('baris dengan variantId sama digabung', async () => {
    const c = await setupCatalog(admin, { stock: 5 });
    const r = await k1.post(
      '/api/transactions',
      cash(c.event.id, [{ variantId: c.variantA.id, quantity: 1 }, { variantId: c.variantA.id, quantity: 2 }], 1_000_000),
    );
    expect(r.status).toBe(201);
    expect(r.body.transaction.items).toHaveLength(1);
    expect(r.body.transaction.items[0].quantity).toBe(3);
  });

  it('harga diambil dari server dan disalin ke transaksi (perubahan harga tidak mengubah transaksi lama)', async () => {
    const c = await setupCatalog(admin, { price: 45000 });
    const r = await k1.post('/api/transactions', cash(c.event.id, [{ variantId: c.variantA.id, quantity: 1 }], 50000));
    await admin.patch(`/api/variants/${c.variantA.id}`, { price: 60000, name: 'A baru' });
    await admin.patch(`/api/products/${c.product.id}`, { name: 'Nama baru' });
    const t = await k1.get(`/api/transactions/${r.body.transaction.id}`);
    expect(t.body.items[0]).toMatchObject({ unitPrice: 45000, productName: c.product.name, variantName: 'A' });
  });
});

describe('idempotensi', () => {
  it('retry dengan clientRequestId sama mengembalikan transaksi yang sama tanpa mengurangi stok lagi', async () => {
    const c = await setupCatalog(admin, { stock: 5 });
    const body = cash(c.event.id, [{ variantId: c.variantA.id, quantity: 2 }], 100000);
    const first = await k1.post('/api/transactions', body);
    expect(first.status).toBe(201);
    const again = await k1.post('/api/transactions', body);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.transaction.id).toBe(first.body.transaction.id);
    expect(again.body.transaction.number).toBe(first.body.transaction.number);

    const p = await admin.get(`/api/products/${c.product.id}`);
    expect(p.body.variants[0].stock).toBe(3);
    expect((await admin.get('/api/transactions')).body.items).toHaveLength(1);
  });

  it('replay tetap berhasil walau event sudah selesai atau stok sudah habis', async () => {
    const c = await setupCatalog(admin, { stock: 1 });
    const body = cash(c.event.id, [{ variantId: c.variantA.id, quantity: 1 }], 50000);
    expect((await k1.post('/api/transactions', body)).status).toBe(201);
    await admin.patch(`/api/events/${c.event.id}`, { status: 'finished' });
    const again = await k1.post('/api/transactions', body);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
  });

  it('clientRequestId sama dengan isi berbeda → 409 IDEMPOTENCY_CONFLICT', async () => {
    const c = await setupCatalog(admin, { stock: 5 });
    const body = cash(c.event.id, [{ variantId: c.variantA.id, quantity: 1 }], 50000);
    expect((await k1.post('/api/transactions', body)).status).toBe(201);
    const diff = await k1.post('/api/transactions', { ...body, items: [{ variantId: c.variantA.id, quantity: 2 }], amountReceived: 100000 });
    expect(diff.status).toBe(409);
    expect(diff.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const otherCashier = await k2.post('/api/transactions', body);
    expect(otherCashier.status).toBe(409);
    expect(otherCashier.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('checkout gagal (stok kurang) tidak "mengunci" clientRequestId — retry setelah restock berhasil', async () => {
    const c = await setupCatalog(admin, { stock: 0 });
    const body = cash(c.event.id, [{ variantId: c.variantA.id, quantity: 1 }], 50000);
    expect((await k1.post('/api/transactions', body)).status).toBe(409);
    await admin.post(`/api/variants/${c.variantA.id}/stock-adjustments`, { delta: 1, reason: 'restock' });
    expect((await k1.post('/api/transactions', body)).status).toBe(201);
  });

  it('10 retry bersamaan dengan ID sama → tepat 1 transaksi', async () => {
    const c = await setupCatalog(admin, { stock: 5 });
    const body = cash(c.event.id, [{ variantId: c.variantA.id, quantity: 1 }], 50000);
    const results = await Promise.all(Array.from({ length: 10 }, () => k1.post('/api/transactions', body)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200 && r.body.replayed)).toHaveLength(9);
    expect(new Set(results.map((r) => r.body.transaction.id)).size).toBe(1);
    const p = await admin.get(`/api/products/${c.product.id}`);
    expect(p.body.variants[0].stock).toBe(4);
  });
});

describe('konkurensi lewat HTTP', () => {
  it('dua kasir membeli unit terakhir bersamaan → tepat satu sukses', async () => {
    const c = await setupCatalog(admin, { stock: 1 });
    const items = [{ variantId: c.variantA.id, quantity: 1 }];
    const [a, b] = await Promise.all([
      k1.post('/api/transactions', cash(c.event.id, items, 50000)),
      k2.post('/api/transactions', cash(c.event.id, items, 50000)),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(loser.body.error.details.items[0]).toMatchObject({ variantId: c.variantA.id, available: 0, requested: 1 });

    const p = await admin.get(`/api/products/${c.product.id}`);
    expect(p.body.variants[0].stock).toBe(0);
    expect((await admin.get('/api/transactions')).body.items).toHaveLength(1);
  });

  it('50 checkout bersamaan untuk stok 7 → tepat 7 sukses, stok 0, riwayat konsisten, nomor unik', async () => {
    const c = await setupCatalog(admin, { stock: 7 });
    const items = [{ variantId: c.variantA.id, quantity: 1 }];
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => (i % 2 ? k1 : k2).post('/api/transactions', cash(c.event.id, items, 50000))),
    );
    const ok = results.filter((r) => r.status === 201);
    expect(ok).toHaveLength(7);
    expect(results.filter((r) => r.status === 409 && r.body.error.code === 'INSUFFICIENT_STOCK')).toHaveLength(43);
    expect(new Set(ok.map((r) => r.body.transaction.number)).size).toBe(7);

    const p = await admin.get(`/api/products/${c.product.id}`);
    expect(p.body.variants[0].stock).toBe(0);
    const mv = await admin.get(`/api/stock-movements?variantId=${c.variantA.id}&limit=200`);
    const sum = mv.body.items.reduce((s: number, m: { delta: number }) => s + m.delta, 0);
    expect(sum).toBe(0); // +7 initial, -7 sale
  });
});

describe('void', () => {
  it('admin membatalkan transaksi → stok kembali, tercatat, tidak bisa dua kali; kasir dilarang', async () => {
    const c = await setupCatalog(admin, { stock: 3 });
    const r = await k1.post('/api/transactions', cash(c.event.id, [{ variantId: c.variantA.id, quantity: 2 }], 100000));
    const id = r.body.transaction.id;

    expect((await k1.post(`/api/transactions/${id}/void`, { reason: 'x' })).status).toBe(403);
    expect((await admin.post(`/api/transactions/${id}/void`, {})).status).toBe(400);

    const v = await admin.post(`/api/transactions/${r.body.transaction.number}/void`, { reason: 'Salah input' });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ status: 'voided', voidReason: 'Salah input', voidedBy: { displayName: 'Admin' } });
    expect((await admin.get(`/api/products/${c.product.id}`)).body.variants[0].stock).toBe(3);

    const mv = await admin.get(`/api/stock-movements?variantId=${c.variantA.id}&reason=void`);
    expect(mv.body.items[0]).toMatchObject({ delta: 2, stockAfter: 3, transactionId: id });

    const again = await admin.post(`/api/transactions/${id}/void`, { reason: 'lagi' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_VOIDED');
  });
});

describe('daftar transaksi & struk', () => {
  it('paginasi, filter, cari nomor, struk JSON & HTML', async () => {
    const c = await setupCatalog(admin, { stock: 50 });
    for (let i = 0; i < 5; i++) {
      await (i % 2 ? k1 : k2).post('/api/transactions', cash(c.event.id, [{ variantId: c.variantA.id, quantity: 1 }], 50000));
    }
    const page1 = await k1.get(`/api/transactions?eventId=${c.event.id}&limit=2`);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).toBe(page1.body.items[1].id);
    const page2 = await k1.get(`/api/transactions?eventId=${c.event.id}&limit=2&before=${page1.body.nextCursor}`);
    expect(page2.body.items[0].id).toBeLessThan(page1.body.items[1].id);
    const all = await k1.get(`/api/transactions?limit=200`);
    expect(all.body.nextCursor).toBeNull();

    const byCashier = await k1.get(`/api/transactions?cashierId=${page1.body.items[0].cashier.id}`);
    expect(byCashier.body.items.every((t: { cashier: { id: number } }) => t.cashier.id === page1.body.items[0].cashier.id)).toBe(true);

    const num = all.body.items[0].number as string;
    expect((await k1.get(`/api/transactions?q=${encodeURIComponent(num)}`)).body.items).toHaveLength(1);
    expect((await k1.get(`/api/transactions/${num}`)).body.number).toBe(num);
    expect((await k1.get(`/api/transactions/${num.toLowerCase()}`)).body.number).toBe(num);
    expect((await k1.get('/api/transactions/ZZ-9999')).status).toBe(404);

    const receipt = await k1.get(`/api/transactions/${num}/receipt`);
    expect(receipt.status).toBe(200);
    expect(receipt.body).toMatchObject({ store: { name: 'Booth Cosplay' }, event: { id: c.event.id }, transaction: { number: num }, timezone: 'Asia/Jakarta' });
    expect(receipt.body.localTime).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}\.\d{2}$/);

    const html = await k1.get(`/api/transactions/${num}/receipt.html?width=80&print=1`);
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toContain('text/html');
    expect(html.body).toContain(num);
    expect(html.body).toContain('size: 80mm');
    expect(html.body).toContain('window.print()');
    expect(html.body).not.toMatch(/https?:\/\//); // tanpa aset eksternal
  });

  it('struk HTML meng-escape nama produk', async () => {
    const c = await setupCatalog(admin, { stock: 5 });
    await admin.patch(`/api/products/${c.product.id}`, { name: '<script>alert(1)</script>' });
    const r = await k1.post('/api/transactions', cash(c.event.id, [{ variantId: c.variantA.id, quantity: 1 }], 50000));
    const html = await k1.get(`/api/transactions/${r.body.transaction.id}/receipt.html`);
    expect(html.body).not.toContain('<script>alert(1)</script>');
    expect(html.body).toContain('&lt;script&gt;');
  });
});
