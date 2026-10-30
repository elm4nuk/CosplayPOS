import type { FastifyInstance } from 'fastify';
import { isAdmin, requireAuth } from '../app.ts';
import type { Ctx } from '../context.ts';
import { AppError } from '../lib/errors.ts';
import { idParam, parse } from '../lib/validation.ts';
import {
  addVariant,
  addVariantSchema,
  createCategory,
  createCategorySchema,
  createProduct,
  createProductSchema,
  deleteProductImage,
  getProduct,
  getProductImage,
  listCategories,
  listProducts,
  listProductsQuery,
  MAX_IMAGE_BYTES,
  setProductImage,
  updateCategory,
  updateCategorySchema,
  updateProduct,
  updateProductSchema,
  updateVariant,
  updateVariantSchema,
} from '../services/catalog.ts';
import { adjustStock, adjustStockSchema, listMovements, listMovementsQuery } from '../services/stock.ts';

export async function registerCatalogRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  // ---- Kategori
  app.get('/api/categories', async () => ({ items: listCategories(ctx) }));

  app.post('/api/categories', { config: { admin: true } }, async (req, reply) =>
    reply.status(201).send(createCategory(ctx, parse(createCategorySchema, req.body))),
  );

  app.patch('/api/categories/:id', { config: { admin: true } }, async (req) =>
    updateCategory(ctx, parse(idParam, req.params).id, parse(updateCategorySchema, req.body)),
  );

  // ---- Produk
  app.get('/api/products', async (req) => {
    const q = parse(listProductsQuery, req.query);
    return {
      items: listProducts(ctx.store, { q: q.q, categoryId: q.categoryId, includeInactive: q.includeInactive && isAdmin(req) }),
    };
  });

  app.get('/api/products/:id', async (req) =>
    getProduct(ctx.store, parse(idParam, req.params).id, { includeInactive: isAdmin(req) }),
  );

  app.post('/api/products', { config: { admin: true } }, async (req, reply) => {
    const auth = requireAuth(req);
    return reply.status(201).send(createProduct(ctx, auth.user.id, parse(createProductSchema, req.body)));
  });

  app.patch('/api/products/:id', { config: { admin: true } }, async (req) =>
    updateProduct(ctx, parse(idParam, req.params).id, parse(updateProductSchema, req.body)),
  );

  app.post('/api/products/:id/variants', { config: { admin: true } }, async (req, reply) => {
    const auth = requireAuth(req);
    return reply
      .status(201)
      .send(addVariant(ctx, auth.user.id, parse(idParam, req.params).id, parse(addVariantSchema, req.body)));
  });

  app.patch('/api/variants/:id', { config: { admin: true } }, async (req) =>
    updateVariant(ctx, parse(idParam, req.params).id, parse(updateVariantSchema, req.body)),
  );

  // ---- Gambar produk
  app.get('/api/products/:id/image', async (req, reply) => {
    const img = getProductImage(ctx.store, parse(idParam, req.params).id, isAdmin(req));
    const etag = `"img-${img.version}"`;
    reply.header('etag', etag).header('cache-control', 'private, max-age=31536000, immutable');
    if (req.headers['if-none-match'] === etag) return reply.status(304).send();
    return reply.type(img.mime).send(Buffer.from(img.data));
  });

  app.put('/api/products/:id/image', { config: { admin: true } }, async (req) => {
    const id = parse(idParam, req.params).id;
    if (!req.isMultipart()) throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Kirim gambar sebagai multipart/form-data dengan field "file"');
    const file = await req.file({ limits: { fileSize: MAX_IMAGE_BYTES } });
    if (!file || file.fieldname !== 'file') throw new AppError('VALIDATION_ERROR', 'Field "file" wajib diisi');
    const data = await file.toBuffer(); // melempar FST_REQ_FILE_TOO_LARGE jika > batas
    return setProductImage(ctx, id, data);
  });

  app.delete('/api/products/:id/image', { config: { admin: true } }, async (req) =>
    deleteProductImage(ctx, parse(idParam, req.params).id),
  );

  // ---- Stok
  app.post('/api/variants/:id/stock-adjustments', { config: { admin: true } }, async (req, reply) => {
    const auth = requireAuth(req);
    return reply
      .status(201)
      .send(adjustStock(ctx, auth.user.id, parse(idParam, req.params).id, parse(adjustStockSchema, req.body)));
  });

  app.get('/api/stock-movements', { config: { admin: true } }, async (req) => listMovements(ctx, parse(listMovementsQuery, req.query)));
}
