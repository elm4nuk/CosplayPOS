/**
 * Isi database dengan data demo: akun kasir, event aktif, kategori & produk.
 * Aman dijalankan berulang (data yang sudah ada dilewati). Pemakaian: npm run seed:demo
 */
import { createCategory, createProduct } from '../server/src/services/catalog.ts';
import { createEvent, getActiveEvent } from '../server/src/services/events.ts';
import { createUser, ensureInitialAdmin } from '../server/src/services/users.ts';
import { updateSettings } from '../server/src/services/settings.ts';
import { localParts } from '../server/src/lib/time.ts';
import { cliContext } from './_cli.ts';

const ctx = cliContext();
const { store } = ctx;

await ensureInitialAdmin(ctx);
const admin = store.get<{ id: number }>("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1")!;

for (const u of [
  { username: 'kasir1', displayName: 'Kasir 1', password: 'kasir123', role: 'cashier' as const },
  { username: 'kasir2', displayName: 'Kasir 2', password: 'kasir123', role: 'cashier' as const },
]) {
  if (store.get('SELECT 1 FROM users WHERE username = ?', u.username)) console.log(`- user ${u.username} sudah ada`);
  else {
    await createUser(ctx, u);
    console.log(`+ user ${u.username} / ${u.password}`);
  }
}

const today = localParts(new Date().toISOString(), ctx.config.timezone).date;
const tomorrow = localParts(new Date(Date.now() + 86_400_000).toISOString(), ctx.config.timezone).date;
if (!store.get("SELECT 1 FROM events WHERE code = 'DEMO'")) {
  createEvent(ctx, {
    code: 'DEMO',
    name: 'Event Demo (Comifuro)',
    location: 'Hall Demo',
    startDate: today,
    endDate: tomorrow,
    status: getActiveEvent(store) ? 'planned' : 'active',
  });
  console.log('+ event DEMO');
} else console.log('- event DEMO sudah ada');

const catId = (name: string, sortOrder: number): number => {
  const row = store.get<{ id: number }>('SELECT id FROM categories WHERE name = ?', name);
  if (row) return row.id;
  return createCategory(ctx, { name, sortOrder }).id;
};
const akrilik = catId('Akrilik', 1);
const print = catId('Print & Poster', 2);
const pin = catId('Pin & Badge', 3);
const lain = catId('Lain-lain', 9);

const products = [
  {
    name: 'Akrilik Stand Genshin',
    categoryId: akrilik,
    variants: [
      { name: 'Raiden', sku: 'ACR-GI-RAI', price: 45000, initialStock: 5 },
      { name: 'Nahida', sku: 'ACR-GI-NAH', price: 45000, initialStock: 3 },
      { name: 'Furina', sku: 'ACR-GI-FUR', price: 45000, initialStock: 1 },
    ],
  },
  {
    name: 'Gantungan Kunci Akrilik Blue Archive',
    categoryId: akrilik,
    variants: [
      { name: 'Hoshino', sku: 'KC-BA-HOS', price: 25000, initialStock: 10 },
      { name: 'Shiroko', sku: 'KC-BA-SHI', price: 25000, initialStock: 8 },
    ],
  },
  {
    name: 'Poster A3 Honkai Star Rail',
    categoryId: print,
    variants: [{ name: '', sku: 'PST-HSR-A3', price: 30000, initialStock: 20 }],
  },
  {
    name: 'Photocard Set (isi 5)',
    categoryId: print,
    variants: [
      { name: 'Set A', sku: 'PC-SET-A', price: 20000, initialStock: 15 },
      { name: 'Set B', sku: 'PC-SET-B', price: 20000, initialStock: 15 },
    ],
  },
  {
    name: 'Pin 58mm',
    categoryId: pin,
    variants: [
      { name: 'Random', sku: 'PIN-58-RND', price: 10000, initialStock: 50 },
      { name: 'Pilih Karakter', sku: 'PIN-58-PICK', price: 15000, initialStock: 30 },
    ],
  },
  {
    name: 'Sticker Sheet',
    categoryId: lain,
    variants: [{ name: '', sku: 'STK-SHEET', price: 15000, initialStock: 40 }],
  },
  {
    name: 'Tote Bag Cosplay',
    categoryId: lain,
    variants: [{ name: '', sku: 'TOTE-01', price: 85000, initialStock: 2 }],
  },
];

for (const p of products) {
  if (store.get('SELECT 1 FROM product_variants WHERE sku = ?', p.variants[0]!.sku)) {
    console.log(`- produk ${p.name} sudah ada`);
    continue;
  }
  createProduct(ctx, admin.id, {
    name: p.name,
    categoryId: p.categoryId,
    description: null,
    active: true,
    variants: p.variants.map((v) => ({ ...v, active: true })),
  });
  console.log(`+ produk ${p.name}`);
}

updateSettings(ctx, { storeName: 'Booth Demo Cosplay', receiptFooter: 'Terima kasih sudah mampir! ✨' });

store.close();
console.log(`
Selesai. Akun demo:
  admin  / ${ctx.config.initialAdminPassword} (jika admin baru dibuat oleh seed ini)
  kasir1 / kasir123
  kasir2 / kasir123
Jika server sedang berjalan, refresh halaman kasir untuk melihat data baru.`);
