import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';
import { APP_ID } from '../config.ts';
import { MIGRATIONS, SCHEMA_VERSION } from './migrations.ts';

export type Row = Record<string, unknown>;

/**
 * Pembungkus satu koneksi SQLite untuk seluruh proses server.
 *
 * node:sqlite bersifat sinkron dan server berjalan di satu proses Node, jadi setiap
 * operasi tulis yang dibungkus `tx()` berjalan utuh tanpa disela request lain.
 * `BEGIN IMMEDIATE` tetap dipakai agar aman bila ada proses lain (mis. skrip CLI)
 * yang membuka file yang sama.
 */
export class Store {
  readonly path: string;
  #db: DatabaseSync | null = null;
  #stmts = new Map<string, StatementSync>();
  #txDepth = 0;

  constructor(dbPath: string) {
    this.path = dbPath;
  }

  open(): this {
    if (this.#db) return this;
    if (this.path !== ':memory:') fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const db = new DatabaseSync(this.path, { enableForeignKeyConstraints: true, timeout: 5000 });
    db.exec('PRAGMA journal_mode = WAL');
    // FULL: commit benar-benar tersimpan ke disk walau laptop mati mendadak.
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA foreign_keys = ON');
    this.#db = db;
    this.#stmts.clear();
    this.migrate();
    return this;
  }

  get isOpen(): boolean {
    return this.#db !== null;
  }

  get db(): DatabaseSync {
    if (!this.#db) throw new Error('Database belum dibuka');
    return this.#db;
  }

  close(): void {
    if (!this.#db) return;
    this.#stmts.clear();
    try {
      this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // abaikan; close tetap dilakukan
    }
    this.#db.close();
    this.#db = null;
  }

  prepare(sql: string): StatementSync {
    let stmt = this.#stmts.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.#stmts.set(sql, stmt);
    }
    return stmt;
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SQLInputValue[]) {
    return this.prepare(sql).run(...params);
  }

  /** Jalankan fn dalam satu transaksi tulis (BEGIN IMMEDIATE). Nested → savepoint-free reuse. */
  tx<T>(fn: () => T): T {
    if (this.#txDepth > 0) return fn();
    const db = this.db;
    db.exec('BEGIN IMMEDIATE');
    this.#txDepth++;
    try {
      const result = fn();
      if (result instanceof Promise) throw new Error('Store.tx tidak boleh berisi fungsi async');
      db.exec('COMMIT');
      return result;
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    } finally {
      this.#txDepth--;
    }
  }

  private migrate(): void {
    const db = this.db;
    const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `Database versi skema ${current} lebih baru dari aplikasi (${SCHEMA_VERSION}). Perbarui aplikasi sebelum membuka database ini.`,
      );
    }
    for (let v = current; v < SCHEMA_VERSION; v++) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(MIGRATIONS[v]!);
        db.exec(`PRAGMA user_version = ${v + 1}`);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
    db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('app', APP_ID);
  }
}

export const toBool = (v: unknown): boolean => v === 1 || v === 1n || v === true;
