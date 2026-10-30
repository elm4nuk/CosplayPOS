import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { APP_ID } from '../config.ts';
import type { Ctx } from '../context.ts';
import { SCHEMA_VERSION } from '../db/migrations.ts';
import { AppError, notFound } from '../lib/errors.ts';
import { fileStamp } from '../lib/time.ts';

export type BackupKind = 'manual' | 'auto' | 'pre-restore';

export interface BackupInfo {
  name: string;
  sizeBytes: number;
  createdAt: string;
  kind: BackupKind;
}

const NAME_RE = /^pos-[0-9TZ-]+-(manual|auto|pre-restore)\.db$/;

export function isValidBackupName(name: string): boolean {
  return NAME_RE.test(name);
}

function info(dir: string, name: string): BackupInfo {
  const st = fs.statSync(path.join(dir, name));
  return {
    name,
    sizeBytes: st.size,
    createdAt: st.mtime.toISOString(),
    kind: NAME_RE.exec(name)![1] as BackupKind,
  };
}

export function listBackups(ctx: Ctx): BackupInfo[] {
  const dir = ctx.config.backupDir;
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(isValidBackupName)
    .map((n) => info(dir, n))
    .sort((a, b) => b.name.localeCompare(a.name));
}

export function backupPath(ctx: Ctx, name: string): string {
  if (!isValidBackupName(name)) throw notFound('Backup');
  const p = path.join(ctx.config.backupDir, name);
  if (!fs.existsSync(p)) throw notFound('Backup');
  return p;
}

/**
 * Snapshot konsisten database yang sedang berjalan (VACUUM INTO) — aman dijalankan saat kasir bertransaksi.
 * Karena node:sqlite sinkron, tidak ada tulisan lain yang menyela selama snapshot dibuat.
 */
export function createBackup(ctx: Ctx, kind: BackupKind): BackupInfo {
  const dir = ctx.config.backupDir;
  fs.mkdirSync(dir, { recursive: true });
  let name = `pos-${fileStamp()}-${kind}.db`;
  for (let i = 1; fs.existsSync(path.join(dir, name)); i++) name = `pos-${fileStamp(new Date(Date.now() + i))}-${kind}.db`;
  const target = path.join(dir, name);
  ctx.store.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  mirror(ctx, target, name);
  if (kind === 'auto') pruneAuto(ctx);
  return info(dir, name);
}

function mirror(ctx: Ctx, source: string, name: string): void {
  const dir = ctx.config.backupMirrorDir;
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(source, path.join(dir, name));
  } catch (err) {
    ctx.log.warn({ err, dir }, 'Gagal menyalin backup ke folder mirror (POS_BACKUP_MIRROR_DIR)');
  }
}

function pruneAuto(ctx: Ctx): void {
  const autos = listBackups(ctx).filter((b) => b.kind === 'auto');
  for (const old of autos.slice(ctx.config.autoBackupKeep)) {
    try {
      fs.unlinkSync(path.join(ctx.config.backupDir, old.name));
    } catch (err) {
      ctx.log.warn({ err, name: old.name }, 'Gagal menghapus backup otomatis lama');
    }
  }
}

/** Pastikan file adalah database kasir ini yang utuh. Melempar INVALID_BACKUP jika tidak. */
export function validateBackupFile(file: string): { schemaVersion: number } {
  let db: DatabaseSync | null = null;
  try {
    const header = Buffer.alloc(16);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, header, 0, 16, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (header.toString('latin1') !== 'SQLite format 3\u0000') throw new Error('bukan file SQLite');
    db = new DatabaseSync(file, { readOnly: true });
    const integrity = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0]!.integrity_check !== 'ok') throw new Error('integrity_check gagal');
    const app = db.prepare("SELECT value FROM meta WHERE key = 'app'").get() as { value: string } | undefined;
    if (app?.value !== APP_ID) throw new Error('bukan database aplikasi kasir ini');
    const schemaVersion = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (schemaVersion < 1 || schemaVersion > SCHEMA_VERSION) throw new Error(`versi skema ${schemaVersion} tidak didukung`);
    for (const t of ['users', 'events', 'products', 'product_variants', 'transactions', 'transaction_items', 'stock_movements']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)) throw new Error(`tabel ${t} tidak ada`);
    }
    return { schemaVersion };
  } catch (err) {
    throw new AppError('INVALID_BACKUP', `File backup tidak valid: ${(err as Error).message}`);
  } finally {
    db?.close();
  }
}

/**
 * Ganti database aktif dengan file backup. Sinkron dari awal sampai akhir sehingga tidak ada
 * request lain yang berjalan di tengah-tengah penggantian.
 */
export function restoreFromFile(ctx: Ctx, sourceFile: string, restoredFrom: string): { restoredFrom: string; preRestoreBackup: BackupInfo } {
  validateBackupFile(sourceFile);
  const preRestoreBackup = createBackup(ctx, 'pre-restore');
  const dbPath = ctx.store.path;
  const staging = `${dbPath}.restore-tmp`;
  fs.copyFileSync(sourceFile, staging);

  ctx.store.close();
  try {
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
    }
    fs.renameSync(staging, dbPath);
  } catch (err) {
    // Gagal mengganti file: buka lagi database lama agar server tetap jalan.
    if (fs.existsSync(staging)) fs.rmSync(staging, { force: true });
    ctx.store.open();
    throw err;
  }
  ctx.store.open(); // menjalankan migrasi jika backup berasal dari versi skema lebih lama
  ctx.store.run('DELETE FROM sessions');
  ctx.bus.publish('restore', {});
  ctx.bus.closeAll();
  ctx.log.info({ restoredFrom, preRestoreBackup: preRestoreBackup.name }, 'Database dipulihkan dari backup');
  return { restoredFrom, preRestoreBackup };
}

/** Backup otomatis berkala — hanya jika ada perubahan sejak backup terakhir. */
export function startAutoBackup(ctx: Ctx): () => void {
  const minutes = ctx.config.autoBackupMinutes;
  if (minutes <= 0) return () => {};
  let lastChanges = -1;
  const timer = setInterval(() => {
    try {
      if (!ctx.store.isOpen) return;
      const changes = ctx.store.get<{ c: number }>('SELECT total_changes() AS c')!.c;
      if (changes === lastChanges) return;
      createBackup(ctx, 'auto');
      lastChanges = ctx.store.get<{ c: number }>('SELECT total_changes() AS c')!.c;
    } catch (err) {
      ctx.log.error({ err }, 'Backup otomatis gagal');
    }
  }, minutes * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
