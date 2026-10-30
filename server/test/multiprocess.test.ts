import { spawn } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clients, setupCatalog, startServer, type TestServer } from './helpers.ts';

let s: TestServer;
afterEach(async () => {
  await s?.destroy();
});

function runWorker(args: string[]): Promise<{ ok: number; insufficient: number; other: string[] }> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(import.meta.dirname, 'fixtures', 'checkout-worker.ts'), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`worker exit ${code}: ${err}`))));
  });
}

describe('konkurensi lintas proses (file SQLite yang sama)', () => {
  it('4 proses × 30 percobaan untuk stok 25 → tepat 25 terjual, tidak pernah oversell', async () => {
    s = await startServer();
    const { admin } = await clients(s);
    const c = await setupCatalog(admin, { stock: 25 });
    const cashierId = s.ctx.store.get<{ id: number }>("SELECT id FROM users WHERE username = 'kasir1'")!.id;

    const results = await Promise.all(
      [1, 2, 3, 4].map((n) => runWorker([s.ctx.config.dbPath, String(c.variantA.id), String(c.event.id), String(cashierId), '30', String(n)])),
    );
    // Proses server juga ikut menjual pada saat yang sama
    const total = results.reduce((acc, r) => ({ ok: acc.ok + r.ok, insufficient: acc.insufficient + r.insufficient }), { ok: 0, insufficient: 0 });
    expect(results.flatMap((r) => r.other)).toEqual([]);
    expect(total.ok).toBe(25);
    expect(total.insufficient).toBe(95);

    const stock = s.ctx.store.get<{ stock: number }>('SELECT stock FROM product_variants WHERE id = ?', c.variantA.id)!.stock;
    expect(stock).toBe(0);
    const sold = s.ctx.store.get<{ n: number }>('SELECT COALESCE(SUM(quantity),0) AS n FROM transaction_items WHERE variant_id = ?', c.variantA.id)!.n;
    expect(sold).toBe(25);
    const numbers = s.ctx.store.get<{ n: number; d: number }>('SELECT COUNT(*) AS n, COUNT(DISTINCT number) AS d FROM transactions')!;
    expect(numbers.n).toBe(numbers.d);
  });
});
