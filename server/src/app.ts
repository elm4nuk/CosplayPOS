import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthInfo, Ctx } from './context.ts';
import { AppError } from './lib/errors.ts';
import { authenticate, LoginLimiter } from './services/auth.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerCatalogRoutes } from './routes/catalog.ts';
import { registerEventRoutes } from './routes/events.ts';
import { registerReportRoutes } from './routes/reports.ts';
import { registerSystemRoutes } from './routes/system.ts';
import { registerTransactionRoutes } from './routes/transactions.ts';

// Pesan validasi zod dalam Bahasa Indonesia.
try {
  z.config(z.locales.id());
} catch {
  // locale tidak tersedia → pakai bawaan
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthInfo | null;
  }
  interface FastifyContextConfig {
    /** Endpoint boleh diakses tanpa login. */
    public?: boolean;
    /** Endpoint khusus admin. */
    admin?: boolean;
  }
}

export const SESSION_COOKIE = 'pos_session';

export function requireAuth(req: FastifyRequest): AuthInfo {
  if (!req.auth) throw new AppError('UNAUTHENTICATED', 'Silakan login terlebih dahulu');
  return req.auth;
}

export const isAdmin = (req: FastifyRequest): boolean => req.auth?.user.role === 'admin';

function tokenFrom(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  return req.cookies[SESSION_COOKIE] ?? null;
}

export interface BuildOptions {
  logger?: boolean | object;
}

export async function buildApp(ctx: Ctx, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 1024 * 1024,
    trustProxy: false,
    // Tidak ada reverse proxy: request datang langsung dari perangkat kasir di LAN.
  });

  app.decorateRequest('auth', null);

  await app.register(cookie);
  await app.register(multipart, { limits: { files: 1, fileSize: 200 * 1024 * 1024, fields: 5 } });

  // Hanya JSON & multipart. text/plain dimatikan: form lintas-situs tidak bisa mengirim JSON tanpa preflight CORS.
  app.removeContentTypeParser('text/plain');
  // JSON parser yang menerima body kosong sebagai {} (mis. POST /logout tanpa body).
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') return done(null, {});
    try {
      done(
        null,
        JSON.parse(text, (key, value) => (key === '__proto__' || key === 'constructor' ? undefined : value)),
      );
    } catch {
      done(new AppError('VALIDATION_ERROR', 'Body JSON tidak valid'), undefined);
    }
  });

  // Aman secara default: semua /api butuh login kecuali ditandai public.
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const token = tokenFrom(req);
    req.auth = token ? authenticate(ctx, token) : null;
    const cfg = req.routeOptions.config;
    if (cfg?.public) return;
    if (!req.routeOptions.url) return; // 404 → ditangani notFoundHandler
    if (!req.auth) throw new AppError('UNAUTHENTICATED', 'Sesi tidak valid atau sudah berakhir. Silakan login lagi.');
    if (cfg?.admin && req.auth.user.role !== 'admin') throw new AppError('FORBIDDEN', 'Hanya admin yang boleh melakukan ini');
  });

  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/') && !reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.status >= 500) req.log.error({ err }, err.message);
      return reply.status(err.status).send(err.toBody());
    }
    const e = err as { code?: string; statusCode?: number; message: string };
    let mapped: AppError;
    if (e.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || e.code === 'FST_REQ_FILE_TOO_LARGE' || e.statusCode === 413) {
      mapped = new AppError('PAYLOAD_TOO_LARGE', 'Ukuran data/berkas terlalu besar');
    } else if (e.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || e.code === 'FST_INVALID_MULTIPART_CONTENT_TYPE' || e.statusCode === 415) {
      mapped = new AppError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type tidak didukung. Gunakan application/json.');
    } else if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      mapped = new AppError('VALIDATION_ERROR', `Request tidak valid: ${e.message}`);
    } else {
      req.log.error({ err }, 'Unhandled error');
      mapped = new AppError('INTERNAL_ERROR', 'Terjadi kesalahan di server. Data tidak berubah sebagian; coba lagi.');
    }
    return reply.status(mapped.status).send(mapped.toBody());
  });

  const limiter = new LoginLimiter();
  await registerSystemRoutes(app, ctx);
  await registerAuthRoutes(app, ctx, limiter);
  await registerEventRoutes(app, ctx);
  await registerCatalogRoutes(app, ctx);
  await registerTransactionRoutes(app, ctx);
  await registerReportRoutes(app, ctx);
  await registerAdminRoutes(app, ctx);

  // ---- Frontend (web/dist milik Codex) -----------------------------------
  const indexHtml = path.join(ctx.config.webDir, 'index.html');
  const hasWeb = fs.existsSync(indexHtml);
  if (hasWeb) {
    await app.register(fastifyStatic, { root: ctx.config.webDir, wildcard: false, index: ['index.html'] });
  } else {
    app.get('/', { config: { public: true } }, async (_req, reply) => reply.type('text/html; charset=utf-8').send(placeholderPage()));
  }

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url === '/api') {
      return reply.status(404).send(new AppError('NOT_FOUND', `Endpoint ${req.method} ${req.url.split('?')[0]} tidak ada`).toBody());
    }
    // SPA fallback: rute frontend (mis. /kasir, /laporan) → index.html
    if (hasWeb && (req.method === 'GET' || req.method === 'HEAD') && !path.extname(req.url.split('?')[0]!)) {
      return reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').sendFile('index.html');
    }
    return reply.status(404).type('text/plain; charset=utf-8').send('Not found');
  });

  return app;
}

function placeholderPage(): string {
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kasir Booth Cosplay — server</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem;color:#222}code{background:#eee;padding:2px 4px;border-radius:3px}</style></head>
<body><h1>Server kasir berjalan ✅</h1>
<p>Frontend belum dibangun (<code>web/dist</code> belum ada). API tersedia di <code>/api</code>.</p>
<p>Cek: <a href="/api/health">/api/health</a> · <a href="/api/server-info">/api/server-info</a></p>
</body></html>`;
}
