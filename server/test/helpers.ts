import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig, type Config } from '../src/config.ts';
import type { Ctx } from '../src/context.ts';
import { Store } from '../src/db/store.ts';
import { EventBus } from '../src/lib/bus.ts';
import { createUser, ensureInitialAdmin } from '../src/services/users.ts';

export interface TestServer {
  ctx: Ctx;
  app: FastifyInstance;
  url: string;
  dataDir: string;
  /** Tutup server tanpa menghapus data (untuk uji restart). */
  stop(): Promise<void>;
  /** Tutup server & hapus data. */
  destroy(): Promise<void>;
}

const silentLog = { info() {}, warn() {}, error() {} };

export function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pos-test-'));
}

export async function startServer(opts: { dataDir?: string; config?: Partial<Config>; seedUsers?: boolean } = {}): Promise<TestServer> {
  const dataDir = opts.dataDir ?? tempDataDir();
  const config = loadConfig({ POS_DATA_DIR: dataDir, POS_WEB_DIR: path.join(dataDir, 'no-web') }, {
    autoBackupMinutes: 0,
    ...opts.config,
  });
  const store = new Store(config.dbPath).open();
  const ctx: Ctx = { config, store, bus: new EventBus(), log: silentLog };
  const app = await buildApp(ctx);
  await ensureInitialAdmin(ctx);
  if (opts.seedUsers !== false && !store.get("SELECT 1 FROM users WHERE username = 'kasir1'")) {
    await createUser(ctx, { username: 'kasir1', displayName: 'Kasir 1', password: 'kasir123', role: 'cashier' });
    await createUser(ctx, { username: 'kasir2', displayName: 'Kasir 2', password: 'kasir123', role: 'cashier' });
  }
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    ctx.bus.closeAll();
    await app.close();
    store.close();
  };
  return {
    ctx,
    app,
    url: `http://127.0.0.1:${port}`,
    dataDir,
    stop,
    async destroy() {
      await stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export class Client {
  token: string | null = null;
  readonly base: string;
  constructor(base: string) {
    this.base = base;
  }

  async req<T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse<T>> {
    const res = await fetch(this.base + url, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...headers,
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    if ((res.headers.get('content-type') ?? '').includes('application/json') && text) parsed = JSON.parse(text);
    return { status: res.status, body: parsed as T, headers: res.headers };
  }

  get<T = any>(url: string) {
    return this.req<T>('GET', url);
  }
  post<T = any>(url: string, body?: unknown) {
    return this.req<T>('POST', url, body ?? {});
  }
  patch<T = any>(url: string, body: unknown) {
    return this.req<T>('PATCH', url, body);
  }

  async login(username: string, password: string): Promise<this> {
    const r = await this.post('/api/auth/login', { username, password });
    if (r.status !== 200) throw new Error(`login ${username} gagal: ${r.status} ${JSON.stringify(r.body)}`);
    this.token = r.body.token;
    return this;
  }
}

export async function clients(s: TestServer) {
  const admin = await new Client(s.url).login('admin', 'admin123');
  const k1 = await new Client(s.url).login('kasir1', 'kasir123');
  const k2 = await new Client(s.url).login('kasir2', 'kasir123');
  return { admin, k1, k2, anon: new Client(s.url) };
}

let skuSeq = 0;
/** Buat event aktif + satu produk dengan varian (stok bisa diatur). */
export async function setupCatalog(admin: Client, opts: { stock?: number; price?: number; eventStatus?: string } = {}) {
  const ev = await admin.post('/api/events', {
    code: `EV${++skuSeq}`,
    name: `Event ${skuSeq}`,
    location: 'Hall',
    startDate: '2026-10-17',
    endDate: '2026-10-18',
    status: opts.eventStatus ?? 'active',
  });
  if (ev.status !== 201) throw new Error(JSON.stringify(ev.body));
  const cat = await admin.post('/api/categories', { name: `Kategori ${skuSeq}` });
  const prod = await admin.post('/api/products', {
    name: `Produk ${skuSeq}`,
    categoryId: cat.body.id,
    variants: [
      { name: 'A', sku: `SKU-${skuSeq}-A`, price: opts.price ?? 45000, initialStock: opts.stock ?? 5 },
      { name: 'B', sku: `SKU-${skuSeq}-B`, price: 20000, initialStock: 10 },
    ],
  });
  if (prod.status !== 201) throw new Error(JSON.stringify(prod.body));
  return {
    event: ev.body,
    category: cat.body,
    product: prod.body,
    variantA: prod.body.variants[0],
    variantB: prod.body.variants[1],
  };
}

export const rid = () => crypto.randomUUID();
