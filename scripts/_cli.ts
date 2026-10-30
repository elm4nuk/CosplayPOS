import { loadConfig } from '../server/src/config.ts';
import type { Ctx } from '../server/src/context.ts';
import { Store } from '../server/src/db/store.ts';
import { EventBus } from '../server/src/lib/bus.ts';

/** Konteks untuk skrip CLI: membuka database yang sama dengan server. */
export function cliContext(): Ctx {
  const config = loadConfig();
  const store = new Store(config.dbPath).open();
  const log = {
    info: (o: unknown, m?: string) => console.log(m ?? o),
    warn: (o: unknown, m?: string) => console.warn('PERINGATAN:', m ?? o),
    error: (o: unknown, m?: string) => console.error('ERROR:', m ?? o, o),
  };
  return { config, store, bus: new EventBus(), log };
}

/** true jika server kasir sedang berjalan di port konfigurasi. */
export async function serverRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}
