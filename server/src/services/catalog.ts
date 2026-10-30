import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { toBool, type Store } from '../db/store.ts';
import { AppError, notFound, rethrowUnique } from '../lib/errors.ts';
import { nowIso } from '../lib/time.ts';
import { optionalText, rupiah, text } from '../lib/validation.ts';
import { getActiveEvent } from './events.ts';
import { insertMovement } from './stock.ts';

// ---------------------------------------------------------------- Kategori

export interface Category {
  id: number;
  name: string;
  sortOrder: number;
  active: boolean;
}

interface CategoryRow {
  id: number;
  name: string;
  sort_order: number;
  active: number;
}

const toCategory = (r: CategoryRow): Category => ({ id: r.id, name: r.name, sortOrder: r.sort_order, active: toBool(r.active) });

export const createCategorySchema = z.object({
  name: text(60),
  sortOrder: z.number().int().min(-10_000).max(10_000).default(0),
});
export const updateCategorySchema = z.object({
  name: text(60).optional(),
  sortOrder: z.number().int().min(-10_000).max(10_000).optional(),
  active: z.boolean().optional(),
});

export function listCategories(ctx: Ctx): Category[] {
  return ctx.store.all<CategoryRow>('SELECT id, name, sort_order, active FROM categories ORDER BY sort_order, name').map(toCategory);
}

function getCategory(store: Store, id: number): Category {
  const row = store.get<CategoryRow>('SELECT id, name, sort_order, active FROM categories WHERE id = ?', id);
  if (!row) throw notFound('Kategori');
  return toCategory(row);
}

export function createCategory(ctx: Ctx, input: z.output<typeof createCategorySchema>): Category {
  const now = nowIso();
  try {
    const r = ctx.store.run(
      'INSERT INTO categories (name, sort_order, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
      input.name,
      input.sortOrder,
      now,
      now,
    );
    ctx.bus.publish('catalog', {});
    return getCategory(ctx.store, Number(r.lastInsertRowid));
  } catch (err) {
    rethrowUnique(err, 'name', `Kategori "${input.name}" sudah ada`);
  }
}

export function updateCategory(ctx: Ctx, id: number, input: z.output<typeof updateCategorySchema>): Category {
  const { store } = ctx;
  const cat = store.tx(() => {
    const before = getCategory(store, id);
    try {
      store.run(
        'UPDATE categories SET name = ?, sort_order = ?, active = ?, updated_at = ? WHERE id = ?',
        input.name ?? before.name,
        input.sortOrder ?? before.sortOrder,
        (input.active ?? before.active) ? 1 : 0,
        nowIso(),
        id,
      );
    } catch (err) {
      rethrowUnique(err, 'name', `Kategori "${input.name}" sudah ada`);
    }
    return getCategory(store, id);
  });
  ctx.bus.publish('catalog', {});
  return cat;
}

// ---------------------------------------------------------------- Produk & varian

export interface Variant {
  id: number;
  productId: number;
  name: string;
  sku: string;
  price: number;
  stock: number;
  active: boolean;
  sortOrder: number;
}

export interface Product {
  id: number;
  name: string;
  categoryId: number | null;
  categoryName: string | null;
  description: string | null;
  imageUrl: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  variants: Variant[];
}

interface ProductRow {
  id: number;
  name: string;
  category_id: number | null;
  category_name: string | null;
  description: string | null;
  image_version: number | null;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface VariantRow {
  id: number;
  product_id: number;
  name: string;
  sku: string;
  price: number;
  stock: number;
  active: number;
  sort_order: number;
}

export const VARIANT_COLS = 'id, product_id, name, sku, price, stock, active, sort_order';

export const toVariant = (r: VariantRow): Variant => ({
  id: r.id,
  productId: r.product_id,
  name: r.name,
  sku: r.sku,
  price: r.price,
  stock: r.stock,
  active: toBool(r.active),
  sortOrder: r.sort_order,
});

const PRODUCT_SELECT = `
  SELECT p.id, p.name, p.category_id, c.name AS category_name, p.description, i.version AS image_version,
         p.active, p.created_at, p.updated_at
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN product_images i ON i.product_id = p.id`;

const toProduct = (r: ProductRow, variants: Variant[]): Product => ({
  id: r.id,
  name: r.name,
  categoryId: r.category_id,
  categoryName: r.category_name,
  description: r.description,
  imageUrl: r.image_version ? `/api/products/${r.id}/image?v=${r.image_version}` : null,
  active: toBool(r.active),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  variants,
});

const skuSchema = z
  .string()
  .trim()
  .min(1, 'SKU wajib diisi')
  .max(40)
  .regex(/^[A-Za-z0-9._\-/]+$/, 'SKU hanya huruf, angka, dan . _ - /');
const variantNameSchema = z.string().trim().max(60).default('');
const stockQty = z.number().int().min(0).max(1_000_000);

const newVariantSchema = z.object({
  name: variantNameSchema,
  sku: skuSchema,
  price: rupiah,
  initialStock: stockQty.default(0),
  active: z.boolean().default(true),
});

export const createProductSchema = z.object({
  name: text(100),
  categoryId: z.number().int().positive().nullish().transform((v) => v ?? null),
  description: optionalText(1000),
  active: z.boolean().default(true),
  variants: z.array(newVariantSchema).min(1, 'Minimal satu varian').max(100),
});

export const updateProductSchema = z.strictObject({
  name: text(100).optional(),
  categoryId: z.number().int().positive().nullable().optional(),
  description: optionalText(1000),
  active: z.boolean().optional(),
});

export const addVariantSchema = newVariantSchema;

export const updateVariantSchema = z.strictObject({
  name: z.string().trim().max(60).optional(),
  sku: skuSchema.optional(),
  price: rupiah.optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(-10_000).max(10_000).optional(),
});

export const listProductsQuery = z.object({
  q: z.string().trim().max(100).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  includeInactive: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
});

function loadVariants(store: Store, productIds: number[] | null, onlyActive: boolean): Map<number, Variant[]> {
  const where = onlyActive ? 'WHERE active = 1' : '';
  const rows = store.all<VariantRow>(`SELECT ${VARIANT_COLS} FROM product_variants ${where} ORDER BY sort_order, id`);
  const wanted = productIds ? new Set(productIds) : null;
  const map = new Map<number, Variant[]>();
  for (const r of rows) {
    if (wanted && !wanted.has(r.product_id)) continue;
    const list = map.get(r.product_id) ?? [];
    list.push(toVariant(r));
    map.set(r.product_id, list);
  }
  return map;
}

export function listProducts(
  store: Store,
  opts: { q?: string | undefined; categoryId?: number | undefined; includeInactive: boolean },
): Product[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (!opts.includeInactive) where.push('p.active = 1');
  if (opts.categoryId) {
    where.push('p.category_id = ?');
    params.push(opts.categoryId);
  }
  if (opts.q) {
    const like = `%${opts.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push(
      `(p.name LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND (v.name LIKE ? ESCAPE '\\' OR v.sku LIKE ? ESCAPE '\\')))`,
    );
    params.push(like, like, like);
  }
  const sql = `${PRODUCT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.sort_order IS NULL, c.sort_order, c.name, p.name, p.id`;
  const rows = store.all<ProductRow>(sql, ...params);
  const variants = loadVariants(store, rows.map((r) => r.id), !opts.includeInactive);
  const products = rows.map((r) => toProduct(r, variants.get(r.id) ?? []));
  // Untuk kasir: produk tanpa varian aktif tidak bisa dijual → sembunyikan.
  return opts.includeInactive ? products : products.filter((p) => p.variants.length > 0);
}

export function getProduct(store: Store, id: number, opts: { includeInactive: boolean } = { includeInactive: true }): Product {
  const row = store.get<ProductRow>(`${PRODUCT_SELECT} WHERE p.id = ?`, id);
  if (!row || (!opts.includeInactive && !toBool(row.active))) throw notFound('Produk');
  const variants = loadVariants(store, [id], !opts.includeInactive).get(id) ?? [];
  return toProduct(row, variants);
}

function assertCategory(store: Store, categoryId: number | null | undefined): void {
  if (categoryId == null) return;
  if (!store.get('SELECT 1 FROM categories WHERE id = ?', categoryId)) {
    throw new AppError('VALIDATION_ERROR', 'Kategori tidak ditemukan', { issues: [{ path: 'categoryId', message: 'Kategori tidak ditemukan' }] });
  }
}

function insertVariant(
  ctx: Ctx,
  userId: number,
  productId: number,
  v: z.output<typeof newVariantSchema>,
  sortOrder: number,
  now: string,
): { variantId: number; stock: number } {
  const { store } = ctx;
  let variantId: number;
  try {
    const r = store.run(
      `INSERT INTO product_variants (product_id, name, sku, price, stock, active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      productId,
      v.name,
      v.sku,
      v.price,
      v.initialStock,
      v.active ? 1 : 0,
      sortOrder,
      now,
      now,
    );
    variantId = Number(r.lastInsertRowid);
  } catch (err) {
    rethrowUnique(err, 'sku', `SKU "${v.sku}" sudah dipakai`);
  }
  if (v.initialStock > 0) {
    insertMovement(store, {
      variantId,
      delta: v.initialStock,
      stockAfter: v.initialStock,
      reason: 'initial',
      note: null,
      transactionId: null,
      eventId: getActiveEvent(store)?.id ?? null,
      userId,
      createdAt: now,
    });
  }
  return { variantId, stock: v.initialStock };
}

function assertUniqueSkus(variants: { sku: string }[]): void {
  const seen = new Set<string>();
  for (const v of variants) {
    const k = v.sku.toLowerCase();
    if (seen.has(k)) throw new AppError('DUPLICATE', `SKU "${v.sku}" dobel di dalam request`, { field: 'sku' });
    seen.add(k);
  }
}

export function createProduct(ctx: Ctx, userId: number, input: z.output<typeof createProductSchema>): Product {
  const { store } = ctx;
  assertUniqueSkus(input.variants);
  const product = store.tx(() => {
    assertCategory(store, input.categoryId);
    const now = nowIso();
    const r = store.run(
      'INSERT INTO products (name, category_id, description, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      input.name,
      input.categoryId,
      input.description ?? null,
      input.active ? 1 : 0,
      now,
      now,
    );
    const productId = Number(r.lastInsertRowid);
    input.variants.forEach((v, i) => insertVariant(ctx, userId, productId, v, i, now));
    return getProduct(store, productId);
  });
  ctx.bus.publish('catalog', { productId: product.id });
  return product;
}

export function updateProduct(ctx: Ctx, id: number, input: z.output<typeof updateProductSchema>): Product {
  const { store } = ctx;
  const product = store.tx(() => {
    const before = getProduct(store, id);
    if (input.categoryId !== undefined) assertCategory(store, input.categoryId);
    store.run(
      'UPDATE products SET name = ?, category_id = ?, description = ?, active = ?, updated_at = ? WHERE id = ?',
      input.name ?? before.name,
      input.categoryId === undefined ? before.categoryId : input.categoryId,
      input.description === undefined ? before.description : input.description,
      (input.active ?? before.active) ? 1 : 0,
      nowIso(),
      id,
    );
    return getProduct(store, id);
  });
  ctx.bus.publish('catalog', { productId: id });
  return product;
}

export function addVariant(ctx: Ctx, userId: number, productId: number, input: z.output<typeof addVariantSchema>): Product {
  const { store } = ctx;
  const product = store.tx(() => {
    getProduct(store, productId);
    const now = nowIso();
    const max = store.get<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM product_variants WHERE product_id = ?', productId)!.m;
    insertVariant(ctx, userId, productId, input, (max ?? -1) + 1, now);
    store.run('UPDATE products SET updated_at = ? WHERE id = ?', now, productId);
    return getProduct(store, productId);
  });
  ctx.bus.publish('catalog', { productId });
  return product;
}

export function updateVariant(ctx: Ctx, variantId: number, input: z.output<typeof updateVariantSchema>): Product {
  const { store } = ctx;
  const product = store.tx(() => {
    const before = store.get<VariantRow>(`SELECT ${VARIANT_COLS} FROM product_variants WHERE id = ?`, variantId);
    if (!before) throw notFound('Varian');
    const now = nowIso();
    try {
      store.run(
        'UPDATE product_variants SET name = ?, sku = ?, price = ?, active = ?, sort_order = ?, updated_at = ? WHERE id = ?',
        input.name ?? before.name,
        input.sku ?? before.sku,
        input.price ?? before.price,
        (input.active ?? toBool(before.active)) ? 1 : 0,
        input.sortOrder ?? before.sort_order,
        now,
        variantId,
      );
    } catch (err) {
      rethrowUnique(err, 'sku', `SKU "${input.sku}" sudah dipakai`);
    }
    store.run('UPDATE products SET updated_at = ? WHERE id = ?', now, before.product_id);
    return getProduct(store, before.product_id);
  });
  ctx.bus.publish('catalog', { productId: product.id });
  return product;
}

// ---------------------------------------------------------------- Gambar

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export function detectImageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function setProductImage(ctx: Ctx, productId: number, data: Buffer): Product {
  const mime = detectImageMime(data);
  if (!mime) throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Gambar harus PNG, JPEG, atau WebP');
  const { store } = ctx;
  const product = store.tx(() => {
    getProduct(store, productId);
    const prev = store.get<{ version: number }>('SELECT version FROM product_images WHERE product_id = ?', productId);
    // Versi selalu naik agar URL berubah (cache browser ter-bust).
    const version = Math.max(Date.now(), (prev?.version ?? 0) + 1);
    store.run(
      `INSERT INTO product_images (product_id, mime, data, version) VALUES (?, ?, ?, ?)
       ON CONFLICT(product_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, version = excluded.version`,
      productId,
      mime,
      data,
      version,
    );
    store.run('UPDATE products SET updated_at = ? WHERE id = ?', nowIso(), productId);
    return getProduct(store, productId);
  });
  ctx.bus.publish('catalog', { productId });
  return product;
}

export function deleteProductImage(ctx: Ctx, productId: number): Product {
  const { store } = ctx;
  const product = store.tx(() => {
    getProduct(store, productId);
    store.run('DELETE FROM product_images WHERE product_id = ?', productId);
    store.run('UPDATE products SET updated_at = ? WHERE id = ?', nowIso(), productId);
    return getProduct(store, productId);
  });
  ctx.bus.publish('catalog', { productId });
  return product;
}

export function getProductImage(store: Store, productId: number, includeInactive: boolean): { mime: string; data: Uint8Array; version: number } {
  const row = store.get<{ mime: string; data: Uint8Array; version: number; active: number }>(
    'SELECT i.mime, i.data, i.version, p.active FROM product_images i JOIN products p ON p.id = i.product_id WHERE i.product_id = ?',
    productId,
  );
  if (!row || (!includeInactive && !toBool(row.active))) throw notFound('Gambar');
  return row;
}
