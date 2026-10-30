# Integration Notes — untuk Codex (frontend `web/`)

Backend: branch `feat/local-pos-core` · Kontrak: [`docs/API_CONTRACT.md`](API_CONTRACT.md) v1.0.0 · Tipe TS: [`shared/api-types.ts`](../shared/api-types.ts)

## 1. Pembagian kepemilikan file

| Milik backend (jangan diedit dari frontend) | Milik frontend (Codex) |
|---|---|
| `server/**`, `scripts/**`, `shared/api-types.ts`, `docs/API_CONTRACT.md`, `docs/INTEGRATION_NOTES.md`, `docs/OPERATIONS_WINDOWS.md`, `package.json` & `package-lock.json` root, `tsconfig.json`, `vitest.config.ts`, `start-server.bat` | `web/**` (termasuk `web/package.json` sendiri), `design-system/**`, `.agents/**` |

Butuh perubahan API? Tulis permintaan (endpoint/field + alasan). Backend memperbarui kontrak + changelog dulu, baru kode.

## 2. Menjalankan server

Prasyarat: **Node.js 24 LTS** (TypeScript dijalankan langsung oleh Node; tidak ada build step backend, tidak ada modul native).

```powershell
npm install          # sekali (butuh internet)
npm run seed:demo    # akun demo + event aktif + produk contoh (aman diulang)
npm run dev          # server + auto-restart saat file server berubah → http://localhost:3000
```

- Data tersimpan di `data/pos.db` (di-gitignore). Reset total: hentikan server lalu hapus folder `data/`.
- Port bisa diganti: `$env:POS_PORT=3001; npm run dev`.
- Tanpa `web/dist`, `/` menampilkan halaman placeholder. Setelah `web/dist/index.html` ada, server otomatis menyajikannya + SPA fallback (rute non-`/api` tanpa ekstensi → `index.html`). Restart server setelah build pertama.

### Akun demo (setelah `npm run seed:demo`)

| Username | Password | Peran |
|---|---|---|
| `admin` | `admin123` | admin |
| `kasir1` | `kasir123` | cashier |
| `kasir2` | `kasir123` | cashier |

Event demo: kode `DEMO`, status `active`. Produk contoh termasuk "Akrilik Stand Genshin – Furina" dengan stok **1** (cocok untuk uji rebutan stok terakhir) dan "Tote Bag" stok 2.

## 3. Pengembangan frontend dengan Vite

Gunakan proxy agar cookie sesi bekerja tanpa CORS (backend sengaja tidak mengaktifkan CORS):

```ts
// web/vite.config.ts
export default defineConfig({
  server: {
    host: true, // agar bisa dites dari HP di LAN
    proxy: { '/api': { target: 'http://localhost:3000' } }, // SSE /api/stream juga lewat proxy ini
  },
  build: { outDir: 'dist' }, // → web/dist, disajikan backend di produksi
});
```

Di produksi (hari event) **tidak ada Vite**: `npm run build` di `web/` → `web/dist` → disajikan backend di port 3000. Pakai path relatif/absolut `/api/...` (jangan hardcode `localhost` — HP kasir mengakses lewat IP laptop).

## 4. Hal penting yang perlu dipatuhi frontend

1. **Offline total.** Jangan memuat font/ikon/script dari CDN. `design-system/cosplay-booth-pos/MASTER.md` saat ini memakai `@import` Google Fonts (Fredoka, Nunito) — itu akan **gagal tanpa internet**. Bundle font secara lokal (mis. paket `@fontsource/fredoka` & `@fontsource/nunito`, atau file `.woff2` di `web/public/fonts`).
2. **Auth.** `POST /api/auth/login` memasang cookie `pos_session` (HttpOnly). Kirim request dengan `credentials: 'same-origin'` (default `fetch`). Jika respons `401 UNAUTHENTICATED` → arahkan ke login. Tidak perlu menyimpan token.
3. **Checkout idempoten** — wajib diikuti:
   ```ts
   // Satu ID per keranjang. Buat baru HANYA setelah sukses atau keranjang diubah.
   let clientRequestId = crypto.randomUUID();
   async function submit(cart) {
     for (let attempt = 0; ; attempt++) {
       try {
         const res = await fetch('/api/transactions', { method: 'POST', headers: { 'content-type': 'application/json' },
           body: JSON.stringify({ clientRequestId, ...cart }) });
         return await res.json(); // 201 baru / 200 replayed / 4xx error bisnis → jangan retry otomatis
       } catch (networkError) {
         if (attempt >= 4) throw networkError; // tampilkan "Cek koneksi Wi-Fi, lalu tekan Coba Lagi" (ID TETAP SAMA)
         await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
       }
     }
   }
   ```
   Catatan: `crypto.randomUUID()` hanya tersedia di *secure context*. Diakses dari HP lewat `http://192.168.x.x` **bukan** secure context, jadi sediakan fallback, mis. `crypto.getRandomValues` → hex 32 karakter.
4. **Kirim `expectedTotal`** (total yang dilihat kasir) agar perubahan harga tidak lolos diam-diam (`409 PRICE_CHANGED`).
5. **QRIS**: tampilkan langkah "Sudah cek notifikasi pembayaran masuk?" sebelum mengirim `qrisConfirmed: true`. Jangan menampilkan teks yang mengesankan verifikasi otomatis.
6. **Stok realtime**: `new EventSource('/api/stream')` → event `stock` berisi stok terbaru per varian. Setelah reconnect (`onerror` lalu `onopen`) fetch ulang `/api/products`. Event `restore` → `location.reload()`.
7. **Struk**: render sendiri dari `GET /api/transactions/:ref/receipt`, atau buka `/api/transactions/:ref/receipt.html?width=58&print=1` di tab baru (sudah siap print & "Save as PDF").
8. **Gambar produk**: `imageUrl` adalah path relatif (`/api/products/7/image?v=...`) yang butuh sesi login — pakai langsung di `<img src>`.
9. **Uang**: integer rupiah. Format dengan `new Intl.NumberFormat('id-ID')`. Jangan pakai float.
10. **Laporan & admin** hanya untuk `role === 'admin'`; sembunyikan menunya untuk kasir (server tetap menolak dengan 403).

## 5. Daftar halaman yang didukung API

| Halaman | Endpoint utama |
|---|---|
| Login | `POST /api/auth/login`, `GET /api/auth/me` |
| Kasir (katalog + keranjang + bayar) | `GET /api/events/active`, `GET /api/categories`, `GET /api/products?q=&categoryId=`, `POST /api/transactions`, `GET /api/stream` |
| Struk | `GET /api/transactions/:ref/receipt(.html)` |
| Riwayat transaksi | `GET /api/transactions?eventId=&cashierId=&q=&before=` |
| Admin: produk & stok | `/api/products`, `/api/variants/:id`, `/api/variants/:id/stock-adjustments`, `/api/stock-movements`, `PUT /api/products/:id/image` |
| Admin: event | `/api/events` |
| Admin: laporan | `GET /api/reports/events/:id/summary`, `GET /api/reports/events/:id/export.csv` |
| Admin: user | `/api/users` |
| Admin: pengaturan & struk | `/api/settings` |
| Admin: backup | `/api/admin/backups`, `/api/admin/restore` |
| Info "buka dari HP" (QR) | `GET /api/server-info` → `lanUrls` (buat QR di frontend, offline) |

## 6. Pengujian backend

```powershell
npm test          # 52 tes: auth, checkout, idempotensi, race HTTP & multi-proses, laporan, CSV, backup/restore, persistensi, SSE, SPA
npm run typecheck
npm run smoke:lan -- http://<ip-laptop>:3000   # uji 2 kasir berebut stok terakhir terhadap server yang sedang jalan
```

## 7. Integrasi git

- Repo dibuat bersamaan: branch Codex `feat/cosplay-pos-ui` dan branch backend `feat/local-pos-core` keduanya mulai dari root commit yang berbeda. Gabungkan sekali dengan:
  ```powershell
  git merge feat/local-pos-core --allow-unrelated-histories
  ```
  Konflik yang mungkin: hanya `.gitignore` / `README.md` bila keduanya membuat file itu (gabungkan isinya). `.gitignore` backend sudah mengabaikan `web/dist/` dan `web/node_modules/`.
- Worktree backend ada di `../Website-kasir-core`.

## 8. Belum selesai / di luar MVP

- Cetak langsung ke **printer thermal Bluetooth** (ESC/POS): belum. Saat ini lewat dialog print browser / PDF. Rencana: endpoint teks ESC/POS atau Web Bluetooth di frontend (Chrome Android).
- **Diskon / promo / bundling**: belum ada. Akan ditambahkan sebagai field baru (`discount`), tanpa mengubah field yang ada.
- **Sinkronisasi/backup cloud**: tidak ada integrasi langsung. Opsi sekarang: `POS_BACKUP_MIRROR_DIR` diarahkan ke folder Google Drive/OneDrive desktop (tersinkron saat ada internet) atau flashdisk.
- Retur sebagian, split payment (tunai + QRIS dalam satu transaksi), hapus produk permanen, impor produk dari CSV, HTTPS di LAN, log audit aksi admin selain riwayat stok.
- Hanya satu event aktif dalam satu waktu (disengaja).
