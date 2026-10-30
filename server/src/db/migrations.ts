/**
 * Migrasi skema berurutan. Versi disimpan di PRAGMA user_version.
 * JANGAN mengubah migrasi yang sudah dirilis — tambahkan migrasi baru.
 */
export const MIGRATIONS: string[] = [
  // 1 — skema awal
  `
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT    NOT NULL,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL CHECK (role IN ('admin', 'cashier')),
    active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at    TEXT    NOT NULL,
    updated_at    TEXT    NOT NULL
  );

  CREATE TABLE sessions (
    id           INTEGER PRIMARY KEY,
    token_hash   TEXT    NOT NULL UNIQUE,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    created_at   TEXT    NOT NULL,
    expires_at   TEXT    NOT NULL,
    last_seen_at TEXT    NOT NULL,
    ip           TEXT,
    user_agent   TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE events (
    id         INTEGER PRIMARY KEY,
    code       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    name       TEXT    NOT NULL,
    location   TEXT,
    start_date TEXT    NOT NULL,
    end_date   TEXT    NOT NULL,
    status     TEXT    NOT NULL CHECK (status IN ('planned', 'active', 'finished')),
    next_seq   INTEGER NOT NULL DEFAULT 1,
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL,
    CHECK (end_date >= start_date)
  );
  -- Maksimal satu event aktif.
  CREATE UNIQUE INDEX events_one_active ON events(status) WHERE status = 'active';

  CREATE TABLE categories (
    id         INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
  );

  CREATE TABLE products (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL,
    category_id INTEGER REFERENCES categories(id),
    description TEXT,
    active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
  );
  CREATE INDEX products_category ON products(category_id);

  -- Gambar disimpan di database agar backup cukup satu file.
  CREATE TABLE product_images (
    product_id INTEGER PRIMARY KEY REFERENCES products(id),
    mime       TEXT    NOT NULL,
    data       BLOB    NOT NULL,
    version    INTEGER NOT NULL
  );

  CREATE TABLE product_variants (
    id         INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    name       TEXT    NOT NULL DEFAULT '',
    sku        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    price      INTEGER NOT NULL CHECK (price >= 0),
    -- CHECK ini adalah jaring pengaman terakhir: stok tidak pernah bisa negatif.
    stock      INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
    active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
  );
  CREATE INDEX variants_product ON product_variants(product_id);

  CREATE TABLE transactions (
    id                  INTEGER PRIMARY KEY,
    number              TEXT    NOT NULL UNIQUE,
    client_request_id   TEXT    NOT NULL UNIQUE,
    request_fingerprint TEXT    NOT NULL,
    event_id            INTEGER NOT NULL REFERENCES events(id),
    cashier_id          INTEGER NOT NULL REFERENCES users(id),
    payment_method      TEXT    NOT NULL CHECK (payment_method IN ('cash', 'qris')),
    status              TEXT    NOT NULL CHECK (status IN ('completed', 'voided')),
    subtotal            INTEGER NOT NULL CHECK (subtotal >= 0),
    total               INTEGER NOT NULL CHECK (total >= 0),
    amount_received     INTEGER NOT NULL CHECK (amount_received >= 0),
    change_amount       INTEGER NOT NULL CHECK (change_amount >= 0),
    item_count          INTEGER NOT NULL CHECK (item_count > 0),
    qris_reference      TEXT,
    note                TEXT,
    created_at          TEXT    NOT NULL,
    voided_at           TEXT,
    voided_by           INTEGER REFERENCES users(id),
    void_reason         TEXT
  );
  CREATE INDEX transactions_event ON transactions(event_id, id);
  CREATE INDEX transactions_cashier ON transactions(cashier_id, id);

  CREATE TABLE transaction_items (
    id             INTEGER PRIMARY KEY,
    transaction_id INTEGER NOT NULL REFERENCES transactions(id),
    variant_id     INTEGER NOT NULL REFERENCES product_variants(id),
    product_id     INTEGER NOT NULL REFERENCES products(id),
    product_name   TEXT    NOT NULL,
    variant_name   TEXT    NOT NULL,
    sku            TEXT    NOT NULL,
    category_id    INTEGER,
    category_name  TEXT,
    unit_price     INTEGER NOT NULL CHECK (unit_price >= 0),
    quantity       INTEGER NOT NULL CHECK (quantity > 0),
    line_total     INTEGER NOT NULL CHECK (line_total >= 0)
  );
  CREATE INDEX transaction_items_tx ON transaction_items(transaction_id);
  CREATE INDEX transaction_items_variant ON transaction_items(variant_id);

  CREATE TABLE stock_movements (
    id             INTEGER PRIMARY KEY,
    variant_id     INTEGER NOT NULL REFERENCES product_variants(id),
    delta          INTEGER NOT NULL CHECK (delta <> 0),
    stock_after    INTEGER NOT NULL CHECK (stock_after >= 0),
    reason         TEXT    NOT NULL CHECK (reason IN ('initial', 'restock', 'correction', 'damaged', 'lost', 'other', 'sale', 'void')),
    note           TEXT,
    transaction_id INTEGER REFERENCES transactions(id),
    event_id       INTEGER REFERENCES events(id),
    user_id        INTEGER REFERENCES users(id),
    created_at     TEXT    NOT NULL
  );
  CREATE INDEX stock_movements_variant ON stock_movements(variant_id, id);
  CREATE INDEX stock_movements_event ON stock_movements(event_id, id);
  CREATE INDEX stock_movements_tx ON stock_movements(transaction_id);

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;
