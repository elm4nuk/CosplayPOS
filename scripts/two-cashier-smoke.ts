/**
 * Uji asap terhadap server yang SEDANG BERJALAN (bisa dijalankan dari laptop lain di LAN):
 * dua kasir login, lalu berebut membeli unit terakhir secara bersamaan.
 *
 *   npm run smoke:lan -- http://192.168.1.10:3000
 *
 * Butuh: akun admin + kasir1 + kasir2 (npm run seed:demo) dan satu event aktif.
 * Membuat satu produk uji "SMOKE-<waktu>" lalu menonaktifkannya kembali.
 */
const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const adminPass = process.env.SMOKE_ADMIN_PASSWORD ?? 'admin123';
const cashierPass = process.env.SMOKE_CASHIER_PASSWORD ?? 'kasir123';

async function call(token: string | null, method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : null,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function login(username: string, password: string): Promise<string> {
  const r = await call(null, 'POST', '/api/auth/login', { username, password });
  if (r.status !== 200) throw new Error(`Login ${username} gagal: ${JSON.stringify(r.body)}`);
  return r.body.token;
}

let failed = false;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failed = true;
};

console.log(`Server: ${base}`);
const health = await call(null, 'GET', '/api/health');
check(health.status === 200, 'server merespons /api/health');

const admin = await login('admin', adminPass);
const k1 = await login('kasir1', cashierPass);
const k2 = await login('kasir2', cashierPass);
check(true, 'admin, kasir1, kasir2 berhasil login');

const active = (await call(k1, 'GET', '/api/events/active')).body.event;
if (!active) throw new Error('Tidak ada event aktif. Aktifkan satu event dulu.');
check(true, `event aktif: ${active.name}`);

const sku = `SMOKE-${Date.now()}`;
const product = await call(admin, 'POST', '/api/products', {
  name: 'Produk Uji Smoke',
  variants: [{ name: '', sku, price: 12345, initialStock: 1 }],
});
check(product.status === 201, 'admin membuat produk uji dengan stok 1');
const variantId = product.body.variants[0].id;

const body = (id: string) => ({
  clientRequestId: id,
  eventId: active.id,
  paymentMethod: 'cash',
  items: [{ variantId, quantity: 1 }],
  amountReceived: 20000,
  expectedTotal: 12345,
});
const id1 = crypto.randomUUID();
const id2 = crypto.randomUUID();
const [r1, r2] = await Promise.all([call(k1, 'POST', '/api/transactions', body(id1)), call(k2, 'POST', '/api/transactions', body(id2))]);
const statuses = [r1.status, r2.status].sort();
check(statuses[0] === 201 && statuses[1] === 409, `checkout bersamaan untuk stok 1 → [${statuses.join(', ')}] (harus [201, 409])`);
const loser = r1.status === 409 ? r1 : r2;
check(loser.body?.error?.code === 'INSUFFICIENT_STOCK', `yang kalah mendapat INSUFFICIENT_STOCK (${loser.body?.error?.code})`);

const winnerId = r1.status === 201 ? id1 : id2;
const winnerToken = r1.status === 201 ? k1 : k2;
const replay = await call(winnerToken, 'POST', '/api/transactions', body(winnerId));
check(replay.status === 200 && replay.body.replayed === true, 'retry dengan clientRequestId sama → replayed, tidak ada transaksi ganda');

const after = await call(admin, 'GET', `/api/products/${product.body.id}`);
check(after.body.variants[0].stock === 0, `stok akhir 0 (didapat ${after.body.variants[0].stock})`);

const txs = await call(admin, 'GET', `/api/transactions?eventId=${active.id}&limit=200`);
const mine = txs.body.items.filter((t: { items: { sku: string }[] }) => t.items.some((i) => i.sku === sku));
check(mine.length === 1, `tepat 1 transaksi tercatat untuk produk uji (didapat ${mine.length})`);

// Bersih-bersih: batalkan transaksi uji & nonaktifkan produk uji agar tidak mengotori laporan.
if (mine[0]) await call(admin, 'POST', `/api/transactions/${mine[0].id}/void`, { reason: 'Transaksi uji smoke test' });
await call(admin, 'PATCH', `/api/products/${product.body.id}`, { active: false });
console.log('Produk uji dinonaktifkan dan transaksi uji di-void.');

console.log(failed ? '\nHASIL: ADA YANG GAGAL' : '\nHASIL: SEMUA LULUS');
process.exitCode = failed ? 1 : 0;
