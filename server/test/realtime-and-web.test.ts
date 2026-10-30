import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clients, rid, setupCatalog, startServer, tempDataDir, type TestServer } from './helpers.ts';

let s: TestServer;
afterEach(async () => {
  await s?.destroy();
});

/** Baca event SSE sampai predikat terpenuhi. */
async function collectSse(url: string, token: string, until: (events: { event: string; data: any }[]) => boolean, timeoutMs = 5000) {
  const ac = new AbortController();
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: { event: string; data: any }[] = [];
  let buf = '';
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const ready = { resolve: () => {} };
  const first = new Promise<void>((r) => (ready.resolve = r));
  const done = (async () => {
    try {
      while (!until(events)) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : null });
          if (ev === 'hello') ready.resolve();
        }
      }
    } finally {
      clearTimeout(timer);
      ac.abort();
    }
    return events;
  })();
  return { first, done };
}

describe('SSE realtime', () => {
  it('kasir lain menerima update stok & transaksi', async () => {
    s = await startServer();
    const { admin, k1, k2 } = await clients(s);
    const c = await setupCatalog(admin, { stock: 3 });
    const sub = await collectSse(`${s.url}/api/stream`, k2.token!, (ev) => ev.some((e) => e.event === 'transaction'));
    await sub.first;
    await k1.post('/api/transactions', {
      clientRequestId: rid(),
      eventId: c.event.id,
      paymentMethod: 'cash',
      items: [{ variantId: c.variantA.id, quantity: 2 }],
      amountReceived: 1_000_000,
    });
    const events = await sub.done;
    const stock = events.find((e) => e.event === 'stock');
    expect(stock?.data.changes).toEqual([{ variantId: c.variantA.id, productId: c.product.id, stock: 1 }]);
    expect(events.find((e) => e.event === 'transaction')?.data).toMatchObject({ eventId: c.event.id, total: 90000, status: 'completed' });
  });

  it('restore mengirim event restore lalu menutup stream', async () => {
    s = await startServer();
    const { admin, k1 } = await clients(s);
    const b = (await admin.post('/api/admin/backups')).body;
    const sub = await collectSse(`${s.url}/api/stream`, k1.token!, () => false);
    await sub.first;
    await admin.post('/api/admin/restore', { name: b.name });
    const events = await sub.done;
    expect(events.map((e) => e.event)).toContain('restore');
  });
});

describe('penyajian frontend', () => {
  it('tanpa web/dist: halaman placeholder di /', async () => {
    s = await startServer();
    const res = await fetch(`${s.url}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Server kasir berjalan');
  });

  it('dengan web/dist: file statis + SPA fallback, /api tetap JSON 404', async () => {
    const dataDir = tempDataDir();
    const web = path.join(dataDir, 'web');
    fs.mkdirSync(path.join(web, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><div id="app">SPA</div>');
    fs.writeFileSync(path.join(web, 'assets', 'app.js'), 'console.log(1)');
    s = await startServer({ dataDir, config: { webDir: web } });

    expect(await (await fetch(`${s.url}/`)).text()).toContain('SPA');
    expect(await (await fetch(`${s.url}/kasir/checkout`)).text()).toContain('SPA');
    const js = await fetch(`${s.url}/assets/app.js`);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${s.url}/assets/missing.js`)).status).toBe(404);
    const api = await fetch(`${s.url}/api/nope`);
    expect(api.status).toBe(404);
    expect((await api.json() as any).error.code).toBe('NOT_FOUND');
  });
});
