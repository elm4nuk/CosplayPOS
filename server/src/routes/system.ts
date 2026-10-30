import type { FastifyInstance } from 'fastify';
import { APP_NAME, APP_VERSION } from '../config.ts';
import type { Ctx } from '../context.ts';
import { lanAddresses } from '../lib/net.ts';
import { nowIso } from '../lib/time.ts';
import { requireAuth } from '../app.ts';
import { getActiveEvent } from '../services/events.ts';

export async function registerSystemRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  app.get('/api/health', { config: { public: true } }, async () => {
    // Sentuh database agar health benar-benar mencerminkan kondisi SQLite.
    ctx.store.get('SELECT 1');
    return { ok: true, time: nowIso(), version: APP_VERSION };
  });

  app.get('/api/server-info', { config: { public: true } }, async () => {
    const active = getActiveEvent(ctx.store);
    return {
      name: APP_NAME,
      version: APP_VERSION,
      port: ctx.config.port,
      lanUrls: lanAddresses().map((ip) => `http://${ip}:${ctx.config.port}`),
      timezone: ctx.config.timezone,
      time: nowIso(),
      activeEvent: active ? { id: active.id, code: active.code, name: active.name } : null,
    };
  });

  app.get('/api/stream', async (req, reply) => {
    const auth = requireAuth(req);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ time: nowIso() })}\n\n`);
    const remove = ctx.bus.add(res, auth.user.id);
    req.raw.on('close', remove);
  });
}
