import { buildApp } from './app.ts';
import { APP_NAME, APP_VERSION, loadConfig } from './config.ts';
import type { Ctx } from './context.ts';
import { Store } from './db/store.ts';
import { EventBus } from './lib/bus.ts';
import { lanAddresses } from './lib/net.ts';
import { createBackup, startAutoBackup } from './services/backup.ts';
import { ensureInitialAdmin } from './services/users.ts';

const config = loadConfig();
const store = new Store(config.dbPath).open();
const bus = new EventBus();

const ctx: Ctx = { config, store, bus, log: console as unknown as Ctx['log'] };
const app = await buildApp(ctx, { logger: { level: config.logLevel } });
ctx.log = app.log; // rute memegang objek ctx yang sama

if (await ensureInitialAdmin(ctx)) {
  app.log.warn(`Akun admin awal dibuat: username "admin", password "${config.initialAdminPassword}". SEGERA ganti password.`);
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EADDRINUSE') {
    console.error(`\nPort ${config.port} sudah dipakai. Apakah server kasir sudah berjalan di jendela lain? Atau set POS_PORT ke port lain.\n`);
  } else {
    console.error(err);
  }
  store.close();
  process.exit(1);
}

const stopAutoBackup = startAutoBackup(ctx);

const urls = lanAddresses().map((ip) => `http://${ip}:${config.port}`);
console.log(`
==============================================================
 ${APP_NAME} v${APP_VERSION} — server lokal berjalan
 Database : ${config.dbPath}
 Backup   : ${config.backupDir}${config.autoBackupMinutes > 0 ? ` (otomatis tiap ${config.autoBackupMinutes} menit)` : ' (otomatis: mati)'}
 Di laptop ini : http://localhost:${config.port}
 Dari HP/tablet (Wi-Fi yang sama):
${urls.length ? urls.map((u) => `   ${u}`).join('\n') : '   (tidak ada alamat LAN — sambungkan laptop ke Wi-Fi/router)'}
 Tekan Ctrl+C untuk berhenti (backup otomatis dibuat saat berhenti).
==============================================================
`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'Menghentikan server…');
  stopAutoBackup();
  bus.closeAll();
  try {
    await app.close();
  } catch (err) {
    app.log.error({ err }, 'Gagal menutup HTTP server dengan rapi');
  }
  try {
    if (config.autoBackupMinutes > 0) {
      const b = createBackup(ctx, 'auto');
      app.log.info({ backup: b.name }, 'Backup saat berhenti dibuat');
    }
  } catch (err) {
    app.log.error({ err }, 'Backup saat berhenti gagal');
  }
  store.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGBREAK', () => void shutdown('SIGBREAK')); // Ctrl+Break / jendela ditutup di Windows
