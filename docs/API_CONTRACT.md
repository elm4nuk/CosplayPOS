# API Contract — Kasir Booth Cosplay (server lokal)

Versi kontrak: **1.0.0** · Pemilik: backend (`feat/local-pos-core`) · Konsumen: frontend `web/` (Codex)

> Aturan perubahan: nama field, tipe, dan kode error di dokumen ini **tidak boleh diubah diam-diam**.
> Perubahan apa pun dicatat di bagian [Changelog](#changelog) dan diumumkan ke frontend sebelum di-merge.
> Penambahan field opsional baru boleh (frontend harus mengabaikan field yang tidak dikenal).

---

## 1. Konvensi umum

| Hal | Aturan |
|---|---|
| Base URL | `http://<ip-laptop-server>:3000` (port bisa diubah lewat `POS_PORT`). Semua endpoint di bawah `/api`. |
| Format | JSON UTF-8. Request yang punya body wajib `Content-Type: application/json` (kecuali upload `multipart/form-data`). |
| Nama field | `camelCase`. |
| ID | Integer positif (`id`). |
| Uang | **Integer rupiah**, tanpa desimal. `15000` = Rp15.000. |
| Waktu | String ISO-8601 UTC dengan milidetik, mis. `"2026-10-16T03:12:45.123Z"`. Tanggal kalender (event, laporan) = `"YYYY-MM-DD"` di zona waktu server (`POS_TIMEZONE`, default `Asia/Jakarta`). |
| Nullable | Field yang bisa kosong selalu dikirim dengan nilai `null` (tidak dihilangkan). |
| List | Endpoint list mengembalikan `{ "items": [...] }`. List berhalaman menambah `"nextCursor": number \| null`; kirim balik sebagai `?before=<nextCursor>`. |
| Internet | Tidak ada endpoint yang membutuhkan internet. Server tidak memanggil layanan luar. |

### 1.1 Format error

Semua error memakai bentuk yang sama:

```json
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "Stok tidak cukup untuk Akrilik Stand – Raiden (sisa 0, diminta 1)",
    "details": { "items": [{ "variantId": 12, "requested": 1, "available": 0 }] }
  }
}
```

`message` berbahasa Indonesia dan aman ditampilkan ke kasir. Frontend **harus bercabang berdasarkan `code`**, bukan `message`. `details` opsional.

| HTTP | `code` | Kapan |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Body/query tidak valid. `details.issues = [{ path, message }]`. |
| 401 | `UNAUTHENTICATED` | Tidak ada sesi / sesi kedaluwarsa / sesi dicabut. Frontend arahkan ke halaman login. |
| 401 | `INVALID_CREDENTIALS` | Username/password salah atau akun nonaktif (login). |
| 403 | `FORBIDDEN` | Peran tidak cukup (mis. kasir memanggil endpoint admin). |
| 404 | `NOT_FOUND` | Resource tidak ada. |
| 409 | `INSUFFICIENT_STOCK` | Checkout: stok salah satu item kurang. `details.items[]`. |
| 409 | `IDEMPOTENCY_CONFLICT` | `clientRequestId` sudah dipakai untuk checkout dengan isi berbeda. |
| 409 | `PRICE_CHANGED` | Checkout: `expectedTotal` ≠ total hitungan server. `details = { expectedTotal, actualTotal }`. |
| 409 | `EVENT_NOT_ACTIVE` | Checkout ke event yang statusnya bukan `active`. |
| 409 | `PRODUCT_UNAVAILABLE` | Checkout: varian/produk nonaktif atau tidak ada. `details.variantIds[]`. |
| 409 | `ANOTHER_EVENT_ACTIVE` | Mengaktifkan event saat event lain masih `active`. `details.activeEventId`. |
| 409 | `DUPLICATE` | Nilai unik bentrok (SKU, username, kode event, nama kategori). `details.field`. |
| 409 | `STOCK_CHANGED` | Penyesuaian stok dengan `expectedStock` yang sudah tidak sesuai. `details.currentStock`. |
| 409 | `NEGATIVE_STOCK` | Penyesuaian stok akan membuat stok < 0. |
| 409 | `ALREADY_VOIDED` | Transaksi sudah dibatalkan. |
| 409 | `LAST_ADMIN` | Menonaktifkan/menurunkan admin aktif terakhir. |
| 409 | `INVALID_STATE` | Operasi tidak valid untuk status saat ini (mis. ubah kode event yang sudah punya transaksi). |
| 413 | `PAYLOAD_TOO_LARGE` | Upload melebihi batas. |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Tipe file/konten tidak didukung. |
| 422 | `INSUFFICIENT_PAYMENT` | Tunai: `amountReceived` < total. `details = { total, amountReceived }`. |
| 422 | `INVALID_BACKUP` | File restore bukan database kasir yang valid. |
| 429 | `TOO_MANY_ATTEMPTS` | Terlalu banyak login gagal. `details.retryAfterSeconds`. |
| 500 | `INTERNAL_ERROR` | Bug server. Tampilkan pesan umum; data tidak berubah sebagian (semua operasi tulis bersifat transaksi atomik). |

---

## 2. Autentikasi & peran

- Login lokal; hash password `scrypt` disimpan di SQLite. **Tidak butuh internet.**
- `POST /api/auth/login` mengembalikan token **dan** memasang cookie `pos_session` (`HttpOnly`, `SameSite=Lax`, `Path=/`).
  - Frontend yang disajikan dari server yang sama (atau lewat proxy Vite) cukup memakai cookie — tidak perlu menyimpan token.
  - Alternatif: header `Authorization: Bearer <token>`. Jika keduanya ada, header yang dipakai.
- Sesi berlaku `POS_SESSION_HOURS` (default 18 jam) sejak login. Logout, ganti password, menonaktifkan user, dan restore database mencabut sesi.
- Satu user boleh login di beberapa perangkat sekaligus.
- Batas login gagal: 10 kali per (username, IP) per 5 menit → `429 TOO_MANY_ATTEMPTS`.

| Peran | Boleh |
|---|---|
| `cashier` | Login/logout/ganti password sendiri, baca event, baca katalog (hanya produk & varian aktif), checkout, baca transaksi & struk, baca pengaturan, SSE. |
| `admin` | Semua yang bisa kasir + kelola user, event, kategori, produk, varian, stok, void transaksi, laporan, ekspor CSV, pengaturan, backup & restore. |

Endpoint publik (tanpa login): `GET /api/health`, `GET /api/server-info`, `POST /api/auth/login`.

---

## 3. Model data

### User
```json
{ "id": 2, "username": "kasir1", "displayName": "Kasir 1", "role": "cashier", "active": true, "createdAt": "2026-10-16T01:00:00.000Z" }
```
`role`: `"admin" | "cashier"`. Password tidak pernah dikembalikan.

### Event
```json
{
  "id": 1, "code": "CF21", "name": "Comifuro 21", "location": "ICE BSD Hall 5-6",
  "startDate": "2026-10-17", "endDate": "2026-10-18",
  "status": "active", "createdAt": "...", "updatedAt": "..."
}
```
- `status`: `"planned" | "active" | "finished"`. **Maksimal satu event `active`** pada satu waktu.
- `code`: 2–12 karakter `A-Z0-9`, unik, dipakai sebagai prefix nomor transaksi. Tidak bisa diubah setelah event punya transaksi.
- Setiap transaksi terikat ke tepat satu event. Checkout hanya bisa ke event `active`.

### Category
```json
{ "id": 3, "name": "Akrilik", "sortOrder": 0, "active": true }
```

### Product & Variant
Unit yang dijual adalah **varian**. Setiap produk punya ≥1 varian. Produk tanpa varian nyata cukup punya satu varian dengan `name: ""` (frontend tampilkan nama produk saja).

```json
{
  "id": 7,
  "name": "Akrilik Stand Genshin",
  "categoryId": 3,
  "categoryName": "Akrilik",
  "description": null,
  "imageUrl": "/api/products/7/image?v=1760583165123",
  "active": true,
  "createdAt": "...",
  "updatedAt": "...",
  "variants": [
    { "id": 12, "productId": 7, "name": "Raiden", "sku": "ACR-GI-RAI", "price": 45000, "stock": 1, "active": true, "sortOrder": 0 },
    { "id": 13, "productId": 7, "name": "Nahida", "sku": "ACR-GI-NAH", "price": 45000, "stock": 0, "active": true, "sortOrder": 1 }
  ]
}
```
- `imageUrl` `null` jika tidak ada gambar. Gambar disimpan di dalam database (ikut ter-backup).
- `sku` unik global (case-insensitive), 1–40 karakter.
- `price` ≥ 0, `stock` ≥ 0. **`stock` tidak bisa diubah lewat PATCH** — hanya lewat checkout, void, atau penyesuaian stok (semuanya tercatat di riwayat).

### StockMovement (riwayat stok)
```json
{
  "id": 88, "variantId": 12, "productId": 7, "productName": "Akrilik Stand Genshin", "variantName": "Raiden", "sku": "ACR-GI-RAI",
  "delta": -1, "stockAfter": 0,
  "reason": "sale",
  "note": null,
  "transactionId": 41, "transactionNumber": "CF21-0041",
  "eventId": 1,
  "userId": 2, "userName": "Kasir 1",
  "createdAt": "..."
}
```
`reason`: `"initial" | "restock" | "correction" | "damaged" | "lost" | "other" | "sale" | "void"`.

### Transaction
```json
{
  "id": 41,
  "number": "CF21-0041",
  "clientRequestId": "6f1c2d0e-1b7a-4c35-9a53-4f8e2a1d9b10",
  "eventId": 1,
  "eventName": "Comifuro 21",
  "cashier": { "id": 2, "displayName": "Kasir 1" },
  "paymentMethod": "cash",
  "status": "completed",
  "items": [
    {
      "id": 77, "variantId": 12, "productId": 7,
      "productName": "Akrilik Stand Genshin", "variantName": "Raiden", "sku": "ACR-GI-RAI", "categoryName": "Akrilik",
      "unitPrice": 45000, "quantity": 1, "lineTotal": 45000
    }
  ],
  "itemCount": 1,
  "subtotal": 45000,
  "total": 45000,
  "amountReceived": 50000,
  "change": 5000,
  "qrisReference": null,
  "note": null,
  "createdAt": "2026-10-17T03:15:00.000Z",
  "voidedAt": null,
  "voidedBy": null,
  "voidReason": null
}
```
- `paymentMethod`: `"cash" | "qris"`. `status`: `"completed" | "voided"`.
- Nama produk/varian/SKU/kategori dan **harga disalin saat transaksi** (snapshot). Mengubah produk tidak mengubah transaksi lama.
- `number` = `<EVENTCODE>-<urutan per event, min 4 digit>`; unik.
- `itemCount` = jumlah semua `quantity`. Saat ini `total == subtotal` (belum ada diskon; jika nanti ditambah, akan berupa field baru `discount`).
- QRIS: `amountReceived = total`, `change = 0`. **QRIS hanya dicatat setelah kasir memverifikasi pembayaran secara manual** (melihat notifikasi di HP/EDC). Server tidak memverifikasi QRIS.
- `voidedBy`: `{ id, displayName } | null`.

### Settings
```json
{
  "storeName": "Booth Cosplay", "storeAddress": null, "storePhone": null,
  "receiptHeader": null, "receiptFooter": "Terima kasih!",
  "lowStockThreshold": 3, "timezone": "Asia/Jakarta"
}
```
`timezone` read-only (dari konfigurasi server).

---

## 4. Endpoint

Notasi: 🔓 publik · 👤 kasir & admin · 🛡 admin saja.

### 4.1 Sistem

**🔓 `GET /api/health`** → `200`
```json
{ "ok": true, "time": "2026-10-16T03:00:00.000Z", "version": "0.1.0" }
```

**🔓 `GET /api/server-info`** → `200` — untuk menampilkan alamat/QR agar HP kasir bisa membuka website.
```json
{
  "name": "Kasir Booth Cosplay", "version": "0.1.0", "port": 3000,
  "lanUrls": ["http://192.168.0.101:3000"],
  "timezone": "Asia/Jakarta", "time": "...",
  "activeEvent": { "id": 1, "code": "CF21", "name": "Comifuro 21" }
}
```
`activeEvent` boleh `null`.

**👤 `GET /api/stream`** — Server-Sent Events (pakai `new EventSource('/api/stream')`, cookie otomatis terkirim). Event:

| `event:` | `data` | Arti |
|---|---|---|
| `hello` | `{ "time": "..." }` | Koneksi siap. |
| `stock` | `{ "changes": [{ "variantId": 12, "productId": 7, "stock": 0 }] }` | Stok berubah (checkout, void, penyesuaian). Update UI tanpa fetch ulang. |
| `transaction` | `{ "id": 41, "number": "CF21-0041", "eventId": 1, "total": 45000, "status": "completed" }` | Transaksi baru / di-void. |
| `catalog` | `{ "productId": 7 }` atau `{}` | Produk/varian/kategori berubah → fetch ulang katalog. |
| `event` | `{ "eventId": 1 }` | Data event berubah (mis. diaktifkan/selesai). |
| `restore` | `{}` | Database dipulihkan. Semua sesi dicabut → frontend reload & login ulang. |

Server mengirim komentar heartbeat setiap 25 detik. `EventSource` otomatis reconnect; setelah reconnect, fetch ulang katalog (bisa ada perubahan yang terlewat).

### 4.2 Auth

**🔓 `POST /api/auth/login`**
```json
{ "username": "kasir1", "password": "kasir123" }
```
→ `200`
```json
{ "token": "b0c3…(64 hex)", "expiresAt": "2026-10-16T21:00:00.000Z", "user": { "...User" } }
```
Error: `400 VALIDATION_ERROR`, `401 INVALID_CREDENTIALS`, `429 TOO_MANY_ATTEMPTS`.

**👤 `POST /api/auth/logout`** → `204` (mencabut sesi saat ini, menghapus cookie).

**👤 `GET /api/auth/me`** → `200 { "user": User, "expiresAt": "..." }`

**👤 `POST /api/auth/change-password`** `{ "currentPassword": "...", "newPassword": "min 6 karakter" }` → `204`. Mencabut semua sesi user ini **kecuali** sesi saat ini.

### 4.3 User 🛡

| Method | Path | Body | Respons |
|---|---|---|---|
| GET | `/api/users` | – | `{ items: User[] }` |
| POST | `/api/users` | `{ username, displayName, password, role }` | `201 User` |
| PATCH | `/api/users/:id` | sebagian dari `{ displayName, role, active, password }` | `200 User` |

- `username`: 3–32 karakter `a-z0-9._-` (disimpan lowercase). `password` ≥ 6 karakter.
- Mengganti `password`, menonaktifkan, atau mengubah `role` mencabut semua sesi user tsb.
- Admin aktif terakhir tidak bisa dinonaktifkan/diturunkan → `409 LAST_ADMIN`.

### 4.4 Event

| Method | Path | Akses | Body | Respons |
|---|---|---|---|---|
| GET | `/api/events` | 👤 | – | `{ items: Event[] }` (terbaru dulu) |
| GET | `/api/events/active` | 👤 | – | `{ event: Event \| null }` |
| GET | `/api/events/:id` | 👤 | – | `Event` |
| POST | `/api/events` | 🛡 | `{ code, name, location?, startDate, endDate, status? }` | `201 Event` |
| PATCH | `/api/events/:id` | 🛡 | sebagian dari `{ code, name, location, startDate, endDate, status }` | `200 Event` |

- `status` default `"planned"`. Set `"active"` saat event lain aktif → `409 ANOTHER_EVENT_ACTIVE` (selesaikan event lama dulu).
- `endDate` ≥ `startDate`.

### 4.5 Kategori

| Method | Path | Akses | Body | Respons |
|---|---|---|---|---|
| GET | `/api/categories` | 👤 | – | `{ items: Category[] }` (urut `sortOrder`, `name`) |
| POST | `/api/categories` | 🛡 | `{ name, sortOrder? }` | `201 Category` |
| PATCH | `/api/categories/:id` | 🛡 | sebagian dari `{ name, sortOrder, active }` | `200 Category` |

### 4.6 Produk & varian

**👤 `GET /api/products`** — query opsional:
- `q` — cari di nama produk, nama varian, SKU.
- `categoryId` — filter kategori.
- `includeInactive=true` — 🛡 saja; kasir selalu hanya melihat produk aktif + varian aktif.

→ `{ "items": Product[] }` urut kategori lalu nama.

**👤 `GET /api/products/:id`** → `Product` (kasir: 404 jika produk nonaktif).

**🛡 `POST /api/products`**
```json
{
  "name": "Akrilik Stand Genshin",
  "categoryId": 3,
  "description": null,
  "active": true,
  "variants": [
    { "name": "Raiden", "sku": "ACR-GI-RAI", "price": 45000, "initialStock": 5 },
    { "name": "Nahida", "sku": "ACR-GI-NAH", "price": 45000, "initialStock": 3 }
  ]
}
```
→ `201 Product`. `initialStock` > 0 tercatat sebagai movement `initial`.

**🛡 `PATCH /api/products/:id`** — sebagian dari `{ name, categoryId, description, active }` → `200 Product`.

**🛡 `POST /api/products/:id/variants`** — `{ name, sku, price, initialStock?, active? }` → `201 Product` (produk lengkap).

**🛡 `PATCH /api/variants/:id`** — sebagian dari `{ name, sku, price, active, sortOrder }` → `200 Product`. Field `stock` ditolak (`400`).

**🛡 `PUT /api/products/:id/image`** — `multipart/form-data`, field `file` (PNG/JPEG/WebP, ≤ 2 MB) → `200 Product`.
**🛡 `DELETE /api/products/:id/image`** → `200 Product`.
**👤 `GET /api/products/:id/image`** → bytes gambar (`Cache-Control` panjang; URL berubah via `?v=` saat gambar diganti).

Produk/varian **tidak dihapus**, hanya dinonaktifkan (`active: false`) agar riwayat transaksi tetap utuh.

### 4.7 Stok 🛡

**`POST /api/variants/:id/stock-adjustments`** — kirim **tepat satu** dari `delta` atau `setTo`:
```json
{ "delta": 10, "reason": "restock", "note": "Kiriman hari ke-2" }
```
```json
{ "setTo": 4, "expectedStock": 5, "reason": "correction", "note": "Hasil stock opname" }
```
- `reason`: `"restock" | "correction" | "damaged" | "lost" | "other"`.
- `expectedStock` opsional: jika stok saat ini ≠ nilai itu (mis. ada penjualan di sela-sela) → `409 STOCK_CHANGED`. Disarankan untuk `setTo`.
- Hasil < 0 → `409 NEGATIVE_STOCK`. Hasil sama dengan stok sekarang (delta 0) → `400`.

→ `201 { "variant": Variant, "movement": StockMovement }`

**`GET /api/stock-movements`** — query: `variantId`, `productId`, `eventId`, `reason`, `limit` (1–200, default 50), `before` → `{ items: StockMovement[], nextCursor }` (terbaru dulu).

### 4.8 Checkout & transaksi

**👤 `POST /api/transactions`** — checkout.
```json
{
  "clientRequestId": "6f1c2d0e-1b7a-4c35-9a53-4f8e2a1d9b10",
  "eventId": 1,
  "paymentMethod": "cash",
  "items": [ { "variantId": 12, "quantity": 1 }, { "variantId": 20, "quantity": 2 } ],
  "amountReceived": 100000,
  "expectedTotal": 95000,
  "note": null
}
```
QRIS:
```json
{
  "clientRequestId": "…", "eventId": 1, "paymentMethod": "qris",
  "items": [ { "variantId": 12, "quantity": 1 } ],
  "qrisConfirmed": true, "qrisReference": "4 digit akhir / nama pengirim (opsional)",
  "expectedTotal": 45000
}
```

| Field | Aturan |
|---|---|
| `clientRequestId` | **Wajib.** String 8–64 karakter `[A-Za-z0-9_-]`, dibuat frontend (`crypto.randomUUID()`) **sekali per keranjang**, dan dipakai ulang untuk setiap retry keranjang yang sama. Buat ID baru hanya setelah checkout sukses atau keranjang diubah. |
| `eventId` | Wajib; event harus `active`. |
| `items` | 1–100 baris; `quantity` 1–999. `variantId` yang sama digabung otomatis. |
| `amountReceived` | Wajib untuk `cash`, ≥ total. Diabaikan untuk `qris`. |
| `qrisConfirmed` | Wajib `true` untuk `qris` (tanda kasir sudah verifikasi manual). |
| `qrisReference` | Opsional, ≤ 100 karakter. |
| `expectedTotal` | Opsional tetapi **disarankan**: total yang dilihat kasir. Jika harga berubah di server → `409 PRICE_CHANGED`, tidak ada yang tersimpan. |
| `note` | Opsional, ≤ 500 karakter. |

Respons:
- `201 { "transaction": Transaction, "replayed": false }` — transaksi baru.
- `200 { "transaction": Transaction, "replayed": true }` — `clientRequestId` ini sudah pernah sukses dengan isi yang sama; **tidak ada transaksi baru, stok tidak berkurang lagi**.
- Error: `400 VALIDATION_ERROR`, `409 EVENT_NOT_ACTIVE`, `409 PRODUCT_UNAVAILABLE`, `409 INSUFFICIENT_STOCK`, `409 PRICE_CHANGED`, `409 IDEMPOTENCY_CONFLICT`, `422 INSUFFICIENT_PAYMENT`.

**Alur checkout (server):**
1. Validasi body. Hitung sidik (fingerprint) dari isi request yang dinormalisasi.
2. Mulai `BEGIN IMMEDIATE` (kunci tulis SQLite — checkout diproses satu per satu).
3. Jika `clientRequestId` sudah ada → sidik sama: kembalikan transaksi lama (`replayed: true`); beda: `409 IDEMPOTENCY_CONFLICT`.
4. Cek event aktif, varian & produk aktif, ambil harga **dari database** (harga dari frontend tidak dipercaya).
5. Hitung total; cek `expectedTotal` dan pembayaran.
6. Untuk tiap item: `UPDATE stock = stock - qty WHERE id = ? AND stock >= qty`. Jika ada yang gagal → `ROLLBACK`, `409 INSUFFICIENT_STOCK` (dengan sisa stok semua item yang kurang).
7. Ambil nomor urut event, simpan transaksi + item snapshot + riwayat stok (`sale`), `COMMIT`.
8. Broadcast SSE `stock` & `transaction`.

Akibatnya: dua kasir yang bersamaan membeli unit terakhir → tepat satu `201`, yang lain `409 INSUFFICIENT_STOCK`.

**Panduan frontend untuk jaringan putus-sambung:** jika request checkout timeout/gagal jaringan, **kirim ulang dengan `clientRequestId` yang sama** sampai mendapat respons. Jangan pernah membuat ID baru untuk retry — itu satu-satunya cara mencegah transaksi ganda.

**👤 `GET /api/transactions`** — query: `eventId`, `cashierId`, `status`, `paymentMethod`, `q` (cari nomor transaksi), `limit` (1–200, default 50), `before` → `{ items: Transaction[], nextCursor }` (terbaru dulu).

**👤 `GET /api/transactions/:ref`** — `:ref` = `id` numerik atau `number` (mis. `CF21-0041`) → `Transaction`.

**🛡 `POST /api/transactions/:ref/void`** — `:ref` = id atau nomor transaksi. `{ "reason": "Salah input" }` (wajib, 1–200 karakter) → `200 Transaction` (status `voided`). Stok dikembalikan (movement `void`). Transaksi void tidak dihitung di laporan omzet. `409 ALREADY_VOIDED`.

### 4.9 Struk

**👤 `GET /api/transactions/:ref/receipt`** → data struk untuk dirender frontend:
```json
{
  "store": { "name": "Booth Cosplay", "address": null, "phone": null, "header": null, "footer": "Terima kasih!" },
  "event": { "id": 1, "code": "CF21", "name": "Comifuro 21", "location": "ICE BSD" },
  "transaction": { "...Transaction" },
  "localTime": "17/10/2026 10.15",
  "timezone": "Asia/Jakarta"
}
```

**👤 `GET /api/transactions/:ref/receipt.html?width=58`** — halaman struk siap cetak (`width` = `58` atau `80` mm, default `58`), tanpa aset eksternal, memanggil `window.print()` jika ditambah `&print=1`. Bisa dibuka di tab baru lalu "Save as PDF" dari dialog print browser. Frontend boleh memakai halaman ini atau merender sendiri dari JSON di atas.

### 4.10 Laporan 🛡

**`GET /api/reports/events/:id/summary?top=10`**
```json
{
  "event": { "...Event" },
  "timezone": "Asia/Jakarta",
  "generatedAt": "...",
  "totals": {
    "revenue": 1250000, "transactionCount": 31, "itemsSold": 44,
    "averageTransaction": 40323, "voidedCount": 1, "voidedAmount": 45000
  },
  "byPaymentMethod": [ { "method": "cash", "transactionCount": 20, "revenue": 800000 }, { "method": "qris", "transactionCount": 11, "revenue": 450000 } ],
  "byDay":  [ { "date": "2026-10-17", "transactionCount": 18, "revenue": 700000, "itemsSold": 25 } ],
  "byHour": [ { "date": "2026-10-17", "hour": 10, "transactionCount": 4, "revenue": 160000, "itemsSold": 6 } ],
  "topProducts":   [ { "productId": 7, "productName": "Akrilik Stand Genshin", "quantity": 12, "revenue": 540000 } ],
  "topVariants":   [ { "variantId": 12, "productName": "Akrilik Stand Genshin", "variantName": "Raiden", "sku": "ACR-GI-RAI", "quantity": 5, "revenue": 225000 } ],
  "topCategories": [ { "categoryName": "Akrilik", "quantity": 20, "revenue": 900000 } ],
  "byCashier":     [ { "cashierId": 2, "displayName": "Kasir 1", "transactionCount": 15, "revenue": 600000 } ]
}
```
- Hanya transaksi `completed` yang dihitung (kecuali `voidedCount`/`voidedAmount`).
- `byDay`/`byHour` memakai zona waktu server; hanya bucket yang punya transaksi yang dikirim. `averageTransaction` dibulatkan ke rupiah terdekat (0 jika tidak ada transaksi).
- `topCategories.categoryName` memakai nama kategori saat transaksi; produk tanpa kategori → `"Tanpa kategori"`.
- `top` = 1–100 (default 10) membatasi `topProducts`, `topVariants`, `topCategories`.

**`GET /api/reports/events/:id/export.csv?type=transactions|items&delimiter=comma|semicolon`**
→ `text/csv; charset=utf-8` dengan BOM (agar Excel membaca UTF-8), `Content-Disposition: attachment`. Default `type=transactions`, `delimiter=comma`. Pakai `semicolon` untuk Excel berbahasa Indonesia.
- `transactions`: `number,createdAtLocal,status,cashier,paymentMethod,itemCount,total,amountReceived,change,qrisReference,note,voidReason`
- `items`: `number,createdAtLocal,status,cashier,paymentMethod,sku,productName,variantName,categoryName,unitPrice,quantity,lineTotal`

### 4.11 Pengaturan

| Method | Path | Akses | Body | Respons |
|---|---|---|---|---|
| GET | `/api/settings` | 👤 | – | `Settings` |
| PATCH | `/api/settings` | 🛡 | sebagian dari `{ storeName, storeAddress, storePhone, receiptHeader, receiptFooter, lowStockThreshold }` | `200 Settings` |

### 4.12 Backup & restore 🛡

Objek backup:
```json
{ "name": "pos-2026-10-17T10-30-00-auto.db", "sizeBytes": 524288, "createdAt": "...", "kind": "auto" }
```
`kind`: `"manual" | "auto" | "pre-restore"`.

| Method | Path | Body | Respons |
|---|---|---|---|
| GET | `/api/admin/backups` | – | `{ items: Backup[], directory: "D:\\...\\data\\backups", autoBackupMinutes: 10 }` (terbaru dulu) |
| POST | `/api/admin/backups` | `{}` | `201 Backup` |
| GET | `/api/admin/backups/:name/download` | – | file `.db` (`application/vnd.sqlite3`, attachment) |
| POST | `/api/admin/restore` | JSON `{ "name": "<nama backup di server>" }` **atau** `multipart/form-data` field `file` (≤ 200 MB) | `200 { "restoredFrom": "...", "preRestoreBackup": Backup }` |

Restore: file divalidasi (`integrity_check` + skema aplikasi ini), database saat ini otomatis di-backup (`pre-restore`), lalu diganti. **Semua sesi dicabut** dan SSE `restore` dikirim — semua perangkat harus login ulang. Error `422 INVALID_BACKUP`.

---

## 5. Catatan untuk frontend

1. Simpan `eventId` dari `GET /api/events/active` saat membuka halaman kasir; tampilkan peringatan jika `null` (checkout tidak bisa).
2. Keranjang: tampilkan stok dari katalog + update realtime dari SSE `stock`. Validasi stok di frontend hanya untuk UX; sumber kebenaran tetap server.
3. Saat `409 INSUFFICIENT_STOCK`: tampilkan item yang kurang dari `details.items`, update stok lokal dengan `available`, biarkan kasir mengubah keranjang (yang berarti `clientRequestId` baru).
4. Saat `409 PRICE_CHANGED`: fetch ulang katalog, tampilkan total baru, minta konfirmasi kasir.
5. Hindari aset dari CDN (font, ikon, script) — website harus jalan tanpa internet. Bundle semua aset di `web/dist`.

---

## Changelog
- **1.0.0** (2026-10-16) — versi awal.
