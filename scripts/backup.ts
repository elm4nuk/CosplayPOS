/**
 * Buat backup manual. Aman dijalankan saat server sedang berjalan.
 *   npm run backup                 → simpan di data/backups
 *   npm run backup -- E:\backup    → juga salin ke folder lain (mis. flashdisk)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createBackup } from '../server/src/services/backup.ts';
import { cliContext } from './_cli.ts';

const ctx = cliContext();
try {
  const b = createBackup(ctx, 'manual');
  const full = path.join(ctx.config.backupDir, b.name);
  console.log(`Backup dibuat: ${full} (${(b.sizeBytes / 1024).toFixed(0)} KB)`);
  const extra = process.argv[2];
  if (extra) {
    fs.mkdirSync(extra, { recursive: true });
    const dest = path.join(path.resolve(extra), b.name);
    fs.copyFileSync(full, dest);
    console.log(`Disalin juga ke: ${dest}`);
  }
} finally {
  ctx.store.close();
}
