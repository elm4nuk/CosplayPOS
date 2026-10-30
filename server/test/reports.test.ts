import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clients, rid, startServer, type Client, type TestServer } from './helpers.ts';

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

describe('laporan per event', () => {
  it('omzet, jumlah transaksi, tren hari/jam (zona waktu), produk/varian/kategori terlaris, metode bayar, kasir, void', async () => {
    const ev = (await admin.post('/api/events', { code: 'CF21', name: 'CF', startDate: '2026-10-17', endDate: '2026-10-18', status: 'active' })).body;
    const catA = (await admin.post('/api/categories', { name: 'Akrilik' })).body;
    const acr = (
      await admin.post('/api/products', {
        name: 'Akrilik',
        categoryId: catA.id,
        variants: [
          { name: 'Raiden', sku: 'A-R', price: 45000, initialStock: 50 },
          { name: 'Nahida', sku: 'A-N', price: 40000, initialStock: 50 },
        ],
      })
    ).body;
    const pin = (await admin.post('/api/products', { name: 'Pin', variants: [{ sku: 'PIN', price: 10000, initialStock: 50 }] })).body;
    const [raiden, nahida] = acr.variants;
    const pinV = pin.variants[0];

    const buy = (c: Client, items: { variantId: number; quantity: number }[], method: 'cash' | 'qris') =>
      c.post('/api/transactions', {
        clientRequestId: rid(),
        eventId: ev.id,
        paymentMethod: method,
        items,
        ...(method === 'cash' ? { amountReceived: 1_000_000 } : { qrisConfirmed: true }),
      });

    const t1 = await buy(k1, [{ variantId: raiden.id, quantity: 2 }], 'cash'); // 90000
    await buy(k1, [{ variantId: pinV.id, quantity: 5 }], 'qris'); // 50000
    await buy(k2, [{ variantId: nahida.id, quantity: 1 }, { variantId: pinV.id, quantity: 1 }], 'cash'); // 50000
    const voidMe = await buy(k2, [{ variantId: raiden.id, quantity: 1 }], 'qris'); // 45000 → void
    await admin.post(`/api/transactions/${voidMe.body.transaction.id}/void`, { reason: 'batal' });

    // Pindahkan waktu transaksi pertama ke 23:30 UTC (= 06:30 WIB hari berikutnya) untuk uji zona waktu.
    s.ctx.store.run("UPDATE transactions SET created_at = '2026-10-16T23:30:00.000Z' WHERE id = ?", t1.body.transaction.id);
    s.ctx.store.run("UPDATE transactions SET created_at = '2026-10-17T03:05:00.000Z' WHERE id <> ?", t1.body.transaction.id);

    const r = await admin.get(`/api/reports/events/${ev.id}/summary?top=2`);
    expect(r.status).toBe(200);
    const sum = r.body;
    expect(sum.timezone).toBe('Asia/Jakarta');
    expect(sum.event.id).toBe(ev.id);
    expect(sum.totals).toEqual({
      revenue: 190000,
      transactionCount: 3,
      itemsSold: 9,
      averageTransaction: 63333,
      voidedCount: 1,
      voidedAmount: 45000,
    });
    expect(sum.byPaymentMethod).toEqual([
      { method: 'cash', transactionCount: 2, revenue: 140000 },
      { method: 'qris', transactionCount: 1, revenue: 50000 },
    ]);
    expect(sum.byDay).toEqual([{ date: '2026-10-17', transactionCount: 3, revenue: 190000, itemsSold: 9 }]);
    expect(sum.byHour).toEqual([
      { date: '2026-10-17', hour: 6, transactionCount: 1, revenue: 90000, itemsSold: 2 },
      { date: '2026-10-17', hour: 10, transactionCount: 2, revenue: 100000, itemsSold: 7 },
    ]);
    expect(sum.topProducts).toEqual([
      { productId: pin.id, productName: 'Pin', quantity: 6, revenue: 60000 },
      { productId: acr.id, productName: 'Akrilik', quantity: 3, revenue: 130000 },
    ]);
    expect(sum.topVariants[0]).toMatchObject({ variantId: pinV.id, quantity: 6, sku: 'PIN' });
    expect(sum.topVariants).toHaveLength(2);
    expect(sum.topCategories).toEqual([
      { categoryName: 'Tanpa kategori', quantity: 6, revenue: 60000 },
      { categoryName: 'Akrilik', quantity: 3, revenue: 130000 },
    ]);
    expect(sum.byCashier).toEqual([
      expect.objectContaining({ displayName: 'Kasir 1', transactionCount: 2, revenue: 140000 }),
      expect.objectContaining({ displayName: 'Kasir 2', transactionCount: 1, revenue: 50000 }),
    ]);
  });

  it('event kosong → semua nol; event tidak ada → 404', async () => {
    const ev = (await admin.post('/api/events', { code: 'E0', name: 'Kosong', startDate: '2026-10-17', endDate: '2026-10-17' })).body;
    const r = await admin.get(`/api/reports/events/${ev.id}/summary`);
    expect(r.body.totals).toEqual({ revenue: 0, transactionCount: 0, itemsSold: 0, averageTransaction: 0, voidedCount: 0, voidedAmount: 0 });
    expect(r.body.byPaymentMethod).toEqual([
      { method: 'cash', transactionCount: 0, revenue: 0 },
      { method: 'qris', transactionCount: 0, revenue: 0 },
    ]);
    expect(r.body.byDay).toEqual([]);
    expect((await admin.get('/api/reports/events/9999/summary')).status).toBe(404);
  });

  it('ekspor CSV: BOM, header, delimiter, escaping & anti formula injection', async () => {
    const ev = (await admin.post('/api/events', { code: 'CF21', name: 'CF', startDate: '2026-10-17', endDate: '2026-10-18', status: 'active' })).body;
    const p = (
      await admin.post('/api/products', { name: '=HYPERLINK("x")', variants: [{ name: 'Besar, "XL"', sku: 'S1', price: 15000, initialStock: 9 }] })
    ).body;
    await k1.post('/api/transactions', {
      clientRequestId: rid(),
      eventId: ev.id,
      paymentMethod: 'cash',
      items: [{ variantId: p.variants[0].id, quantity: 2 }],
      amountReceived: 50000,
      note: 'baris1\nbaris2',
    });

    const tx = await admin.get(`/api/reports/events/${ev.id}/export.csv`);
    expect(tx.status).toBe(200);
    expect(tx.headers.get('content-type')).toContain('text/csv');
    expect(tx.headers.get('content-disposition')).toBe('attachment; filename="CF21-transactions.csv"');
    // fetch().text() membuang BOM → periksa byte mentah.
    const raw = Buffer.from(
      await (await fetch(`${s.url}/api/reports/events/${ev.id}/export.csv`, { headers: { authorization: `Bearer ${admin.token}` } })).arrayBuffer(),
    );
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = raw.subarray(3).toString('utf8').split('\r\n');
    expect(lines[0]).toBe('number,createdAtLocal,status,cashier,paymentMethod,itemCount,total,amountReceived,change,qrisReference,note,voidReason');
    expect(lines[1]).toMatch(/^CF21-0001,\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},completed,Kasir 1,tunai,2,30000,50000,20000,,"baris1\nbaris2",$/);

    const items = await admin.get(`/api/reports/events/${ev.id}/export.csv?type=items&delimiter=semicolon`);
    const il = (items.body as string).replace(/^﻿/, '').split('\r\n');
    expect(il[0]).toBe('number;createdAtLocal;status;cashier;paymentMethod;sku;productName;variantName;categoryName;unitPrice;quantity;lineTotal');
    expect(il[1]).toContain(`;S1;'=HYPERLINK(""x"")`.replace(`'=HYPERLINK(""x"")`, `"'=HYPERLINK(""x"")"`));
    expect(il[1]).toContain(';Besar, "XL";'.replace('Besar, "XL"', '"Besar, ""XL"""'));
    expect(il[1]).toMatch(/;Tanpa kategori;15000;2;30000$/);
  });
});
