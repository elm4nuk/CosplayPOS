/**
 * Pulihkan database dari file backup. HENTIKAN server dulu (atau pakai menu restore di halaman admin).
 *   npm run restore -- data\backups\pos-2026-10-17T10-30-00-000Z-auto.db
 *   npm run restore -- --list
 */
import fs from 'node:fs';
import path from 'node:path';
import { listBackups, restoreFromFile } from '../server/src/services/backup.ts';
import { cliContext, serverRunning } from './_cli.ts';

const arg = process.argv[2];
const ctx = cliContext();
try {
  if (!arg || arg === '--list') {
    const items = listBackups(ctx);
    console.log(items.length ? `Backup di ${ctx.config.backupDir}:` : `Belum ada backup di ${ctx.config.backupDir}`);
    for (const b of items) console.log(`  ${b.name}  ${(b.sizeBytes / 1024).toFixed(0)} KB  [${b.kind}]`);
    if (!arg) console.log('\nPemakaian: npm run restore -- <path-file-backup | nama-backup>');
  } else {
    if (await serverRunning(ctx.config.port)) {
      console.error(
        `Server kasir masih berjalan di port ${ctx.config.port}. Hentikan dulu (Ctrl+C di jendela server), atau gunakan menu Restore di halaman admin.`,
      );
      process.exitCode = 1;
    } else {
      const candidate = fs.existsSync(arg) ? path.resolve(arg) : path.join(ctx.config.backupDir, arg);
      if (!fs.existsSync(candidate)) throw new Error(`File tidak ditemukan: ${arg}`);
      const r = restoreFromFile(ctx, candidate, path.basename(candidate));
      console.log(`Database dipulihkan dari ${candidate}`);
      console.log(`Database sebelumnya disimpan sebagai ${r.preRestoreBackup.name}`);
      console.log('Semua sesi login dicabut — semua kasir perlu login ulang.');
    }
  }
} catch (err) {
  console.error('Restore gagal:', (err as Error).message);
  process.exitCode = 1;
} finally {
  ctx.store.close();
}
