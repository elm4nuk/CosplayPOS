import path from 'node:path';

export const APP_ID = 'kasir-booth-cosplay';
export const APP_NAME = 'Kasir Booth Cosplay';
export const APP_VERSION = '0.1.0';

/** Root repo (dua level di atas server/src). */
export const ROOT_DIR = path.resolve(import.meta.dirname, '..', '..');

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  backupDir: string;
  /** Folder kedua (mis. flashdisk / folder Google Drive) yang menerima salinan setiap backup. Opsional. */
  backupMirrorDir: string | null;
  webDir: string;
  timezone: string;
  sessionHours: number;
  /** 0 = backup otomatis mati. */
  autoBackupMinutes: number;
  autoBackupKeep: number;
  logLevel: string;
  /** Password admin awal jika database belum punya user sama sekali. */
  initialAdminPassword: string;
}

function intFromEnv(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Konfigurasi ${name} harus bilangan bulat >= 0, didapat "${value}"`);
  return n;
}

function validTimezone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    throw new Error(`POS_TIMEZONE tidak dikenal: "${tz}"`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const dataDir = path.resolve(ROOT_DIR, env.POS_DATA_DIR ?? 'data');
  const port = intFromEnv(env.POS_PORT, 3000, 'POS_PORT');
  const base: Config = {
    host: env.POS_HOST ?? '0.0.0.0',
    port,
    dataDir,
    dbPath: path.resolve(dataDir, env.POS_DB_FILE ?? 'pos.db'),
    backupDir: path.resolve(dataDir, 'backups'),
    backupMirrorDir: env.POS_BACKUP_MIRROR_DIR ? path.resolve(env.POS_BACKUP_MIRROR_DIR) : null,
    webDir: path.resolve(ROOT_DIR, env.POS_WEB_DIR ?? path.join('web', 'dist')),
    timezone: validTimezone(env.POS_TIMEZONE ?? 'Asia/Jakarta'),
    sessionHours: intFromEnv(env.POS_SESSION_HOURS, 18, 'POS_SESSION_HOURS') || 18,
    autoBackupMinutes: intFromEnv(env.POS_AUTO_BACKUP_MINUTES, 10, 'POS_AUTO_BACKUP_MINUTES'),
    autoBackupKeep: intFromEnv(env.POS_AUTO_BACKUP_KEEP, 60, 'POS_AUTO_BACKUP_KEEP') || 60,
    logLevel: env.POS_LOG_LEVEL ?? 'info',
    initialAdminPassword: env.POS_ADMIN_PASSWORD ?? 'admin123',
  };
  const merged = { ...base, ...overrides };
  if (overrides.dataDir && !overrides.dbPath) merged.dbPath = path.resolve(overrides.dataDir, 'pos.db');
  if (overrides.dataDir && !overrides.backupDir) merged.backupDir = path.resolve(overrides.dataDir, 'backups');
  return merged;
}
