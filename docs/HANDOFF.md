# HANDOFF — kontrak bersama Claude Code ↔ Codex

Dokumen ini adalah sumber kebenaran untuk pembagian kerja CosplayPOS. Siapa pun yang mengubah kontrak di bawah **wajib memperbarui file ini di perubahan yang sama**. Tambahkan catatan baru di § Log, jangan hapus catatan lama.

Terakhir diperbarui: 2026-10-16 oleh Codex.

## 1. Keputusan proyek (dari pemilik, 2026-10-16)

Keputusan ini **menggantikan** poin yang bertentangan di `docs/TECHNICAL_DIRECTION.md` (ditulis sebelum keputusan berikut ada):

1. Target: **APK Android standalone, satu HP, 100% offline**. Server LAN (`Website-kasir-core`) ditunda. Sinkronisasi multi-HP/cloud = fase berikutnya, bukan sekarang.
2. Source APK lama (`com.cosplaypos.app`) **tidak tersedia**. Repo ini (`feat/cosplay-pos-ui`) adalah titik awal baru. APK lama hanya referensi fitur/perilaku. Jangan memulihkan proyek dari bundle APK.
3. Karena itu scaffold Capacitor + `android/` **sudah dibuat di repo ini**, dan Dexie dipakai untuk IndexedDB (lihat § 4).
4. Tidak ada migrasi data dari APK lama. Jangan klaim kompatibilitas dengan APK lama.
5. openIndoPOS: repo tidak punya lisensi (dicek via GitHub API, `license: null`) → **all rights reserved**. Hanya referensi alur; dilarang menyalin kode, aset, atau teks.
6. Printer Bluetooth menunggu model printer diketahui. Sekarang: struk bisa dilihat dan disimpan/dibagikan sebagai teks 58 mm.
7. **Revisi MVP (pemilik, 2026-10-16): tidak ada login, password, onboarding PIN, atau pengunci sesi.** Aplikasi langsung membuka kasir dan semua operasi lokal dapat dipakai offline. Pembatalan transaksi, restore backup, arsip/hapus data memakai konfirmasi UI yang menjelaskan dampaknya; pembatalan wajib menyimpan alasan. Fondasi PIN lama boleh tetap sebagai kode kompatibilitas hanya bila tidak menambah langkah pengguna, tetapi backup baru tidak boleh bergantung pada PIN.

## 2. Kepemilikan file

| Area | Pemilik | File |
|---|---|---|
| UI, alur kasir, visual, aksesibilitas (wajib UI/UX Pro Max) | **Codex** | `src/App.tsx`, `src/styles.css`, `src/App.test.tsx`, `src/main.tsx`, `index.html`, `public/**`, `docs/DESIGN_SYSTEM.md`, `docs/FRONTEND_INTEGRATION.md`, `docs/TECHNICAL_DIRECTION.md` |
| Penyimpanan, integritas checkout/stok, backup/restore, PIN, struk teks, aset offline, build Android | **Claude Code** | `src/storage/**`, `src/platform/**`, `src/services/localPosService.ts`, `src/services/localPosService.test.ts`, `src/services/index.ts`, `capacitor.config.ts`, `android/**`, `scripts/**` |
| Bersama: ubah hanya dengan menambah, catat di § Log | keduanya | `src/types.ts`, `package.json`, `docs/HANDOFF.md`, `README.md` |
| Prototipe, jangan dipakai di build APK | Codex boleh ubah | `src/services/posService.ts` (`mockPosService`), `src/data/mockData.ts` (dipakai `src/testing/demoCatalog.ts` untuk test/dev saja) |
| Build uji perangkat (jangan dibagikan) | Claude Code | `vite.e2e.config.ts` → `dist-e2e/`, `scripts/device-e2e.mjs`, `scripts/gradle-assemble.mjs`, `src/testing/**` |

Aturan:
- Jangan edit file milik pihak lain. Kalau butuh perubahan, tulis permintaan di § 8 (Antrian permintaan).
- Codex memanggil data **hanya** lewat `posService` dari `src/services/index.ts`. Jangan import `PosDatabase`/Dexie dari komponen UI.

## 3. Status fitur

| Fitur | Data/logic (Claude) | UI (Codex) | Catatan |
|---|---|---|---|
| Penyimpanan lokal IndexedDB | ✅ selesai + test | — | `navigator.storage.persist()` dipanggil saat `ready()` |
| Akses langsung tanpa login/PIN | ✅ selesai + test | ✅ langsung ke kasir | metadata PIN lama dibersihkan saat `ready()` |
| Checkout tunai atomik + idempoten | ✅ selesai + test | ✅ `localPosService` | lihat § 6.2 |
| Void transaksi (kembalikan stok + alasan) | ✅ | ✅ dialog dampak + alasan wajib | tanpa autentikasi |
| Produk/kategori CRUD, arsip | ✅ | ✅ | hapus/arsip memakai konfirmasi |
| Penyesuaian stok + audit | ✅ | ✅ | stok varian lama **hanya** berubah lewat `adjustStock()` |
| Event + event aktif | ✅ | ✅ | |
| Laporan event (omzet, jam, produk terlaris) | ✅ | ✅ | dihitung dari transaksi tersimpan |
| Backup ekspor/restore + auto-backup | ✅ | ✅ | restore memakai konfirmasi dampak, tanpa PIN |
| Struk teks 58 mm (lihat/simpan/bagikan) | ✅ | ✅ | |
| Font, ikon, ilustrasi lokal | ✅ diverifikasi `npm run check:offline` | — | |
| Proyek Android + `cap sync` | ✅ | — | |
| Build APK debug | ✅ `BUILD SUCCESSFUL` (JDK 21 + SDK 36 terpasang, `docs/ANDROID_SETUP.md`) | — | APK rilis bertanda tangan belum (butuh keystore) |
| Rilis APK bertanda tangan | ⏳ prosedur siap (`docs/RELEASE_SIGNING.md`), keystore belum dibuat | — | Butuh password pemilik; `signingConfigs` belum ditulis ke `android/app/build.gradle` |
| Uji perangkat otomatis (gerbang 1–8, lapisan service) | ✅ `npm run android:e2e` / `scripts/device-e2e.mjs` | ⏳ alur layar perlu pass UI | lihat § 8 untuk hasil terakhir |
| Printer Bluetooth | ⏸ menunggu model printer | ⏸ | `formatReceiptText()` sudah 32 kolom ESC/POS-ready |
| Sinkronisasi multi-HP | ⏸ fase berikutnya | ⏸ | |

## 4. Keputusan teknis

| Keputusan | Alasan |
|---|---|
| **IndexedDB via Dexie 4** (Apache-2.0), bukan SQLite | Satu HP, data kecil (ratusan produk, ribuan transaksi per event). Transaksi `rw` IndexedDB cukup untuk checkout atomik. Dexie memberi skema berversi + `upgrade()` untuk migrasi aman. SQLite (`@capacitor-community/sqlite`) baru dipertimbangkan bila ada masalah terukur: data hilang/terhapus WebView, performa query laporan, atau kebutuhan sync. |
| Uang = **integer rupiah** (`Number.isSafeInteger`) | Tidak ada float. |
| Harga/nama di transaksi diambil dari DB saat checkout, bukan dari keranjang | Keranjang bisa basi atau dimanipulasi. Test: `memakai harga dari database`. |
| Checkout = satu transaksi Dexie (`meta`, `events`, `products`, `transactions`, `stockMovements`) | Semua tersimpan atau tidak sama sekali. Tidak ada stok yang berkurang tanpa transaksi. |
| `idempotencyKey` per percobaan checkout | Tap ganda / retry tidak menjual dua kali. Kunci sama + isi beda → `IDEMPOTENCY_CONFLICT`. |
| Stok varian lama tidak bisa diubah lewat `saveProduct()` | Semua perubahan stok punya baris audit di `stockMovements`. |
| Dua PIN, PBKDF2-SHA256, 150.000 iterasi, salt 16 byte per PIN; tidak ada PIN bawaan | PIN = pengaman layar kasir, **bukan enkripsi data**. Siapa pun dengan akses root/ADB tetap bisa membaca DB. |
| Kewenangan: PIN kasir **atau** pemilik membuka kasir; aksi sensitif minta PIN pemilik **setiap kali** (bahkan di sesi pemilik) | Kasir yang ditinggal terbuka tidak bisa dipakai untuk void/restore. Sensitif = void, restore, `receiptPrefix`, ganti PIN pemilik. Nama booth/footer/nama kasir bebas diubah. |
| Lockout terpisah: `unlock` dan `owner`; 5 salah → 30 dtk, berlipat, maks 15 menit | Kasir yang salah-salah di layar buka tidak mengunci persetujuan pemilik. |
| Restore tanpa PIN **hanya** pada instalasi yang belum onboarding | Instalasi baru tidak punya data untuk dilindungi; backup membawa kedua PIN. Pindah HP / uji restore cukup dari layar setup. |
| Origin WebView dikunci: `https://localhost` | IndexedDB terikat origin. Lihat § 7 Aturan rilis. |
| `appId` = `com.cosplaypos.booth` (beda dari APK lama `com.cosplaypos.app`) | Bisa terpasang berdampingan dengan APK lama selama masa transisi. Kunci kerja sebelum rilis pertama ke pemakaian nyata; setelah itu **tidak boleh diganti**. |
| Font via `@fontsource`, ikon via `lucide-react` (SVG inline), gambar di `public/` | Semua masuk bundle. `npm run check:offline` gagal jika ada URL jaringan atau file lokal hilang. (APK lama gagal cek ini: Google Fonts.) |

## 5. Model data (skema v1, `src/storage/db.ts`, DB `cosplaypos-booth`)

| Tabel | Kunci / indeks | Isi |
|---|---|---|
| `meta` | `key` | `createdAt`, `activeEventId`, `txSeq` (nomor urut struk), `settings` (`ShopSettings`: `shopName` = nama booth di struk, `footer`, `receiptPrefix`, `defaultCashier`), `pin:cashier` & `pin:owner` (`{ salt, hash, iterations }`), `pinGuard:unlock` & `pinGuard:owner` (lockout, tidak ikut backup) |
| `categories` | `id`, `sortOrder` | `{ id, name, color, sortOrder }` |
| `products` | `id`, `categoryId` | `{ id, name, categoryId, description, accent, featured, archived, variants: [{ id, name, price, stock, sku }], createdAt, updatedAt }` |
| `events` | `id`, `createdAt` | `{ id, name, venue, dateLabel, createdAt }` (aktif = `meta.activeEventId`) |
| `transactions` | `id`, `&number`, `seq`, `eventId`, `createdAt` | `{ id, seq, number, eventId, createdAt, cashierName, items: [{ productId, productName, variantId, variantName, sku, price, quantity }], total, cashReceived, change, status: 'completed'\|'void', voidedAt?, voidReason? }` |
| `stockMovements` | `id`, `variantId`, `createdAt`, `transactionId` | `{ id, kind: 'initial'\|'sale'\|'adjustment'\|'void', productId, variantId, productName, variantName, delta, stockAfter, reason, actor, createdAt, transactionId? }` |

Semua timestamp ISO-8601 UTC. Item transaksi adalah **snapshot**: mengubah/menghapus produk tidak mengubah riwayat.

### Migrasi
- Jangan ubah blok `version(1)` setelah ada APK yang dipakai. Tambah `version(2).stores(...).upgrade(tx => ...)`.
- Setiap versi baru wajib punya test yang: tulis data dengan skema lama → buka dengan skema baru → bandingkan jumlah dan isi transaksi, produk, varian, stok identik.
- File backup membawa `schemaVersion`; restore menolak backup dari versi yang lebih baru.

## 6. API untuk UI (`import { posService, isPosError } from './services'`)

Semua method async. Error bisnis dilempar sebagai `PosError` dengan `code` (bisa di-branch) dan `message` (bahasa Indonesia, siap tampil).

### 6.1 Startup langsung tanpa autentikasi
```ts
const { firstRun } = await posService.ready()
const data = await posService.getBootstrap()
```
`ready()` membuat event awal bila database baru, membersihkan metadata `pin:*`/`pinGuard:*` dari build lama, dan tidak mengunci operasi apa pun. Nama booth/kasir awal adalah CosplayPOS/Kasir dan dapat diubah dari Pengaturan.

### 6.2 Checkout
```ts
const key = crypto.randomUUID()   // buat SEKALI saat modal pembayaran dibuka, pakai ulang saat retry
const tx = await posService.createTransaction({ eventId, items: cart, cashReceived, idempotencyKey: key })
```
`items` boleh `CartItem[]`; hanya `productId`, `variantId`, `quantity` yang dipakai. Kode: `EMPTY_CART`, `INSUFFICIENT_CASH` (`details.total`), `STOCK_CHANGED` (`details.shortages: [{ variantId, requested, available }]` → muat ulang bootstrap, tandai baris keranjang), `EVENT_NOT_FOUND`, `IDEMPOTENCY_CONFLICT`. Setelah sukses: `getBootstrap()` lagi untuk stok terbaru.

Catatan UI: tidak ada server, jadi status `ConnectionStatus`/"Terhubung ke server lokal" dan blokir `status !== 'connected'` di `CheckoutModal` sudah tidak relevan untuk APK.

### 6.3 Data & katalog
```ts
getBootstrap(): BootstrapData        // categories[0] = { id:'all', name:'Semua' } (pseudo, demi filter UI sekarang)
saveCategory({ id?, name, color? }); deleteCategory(id)        // tolak jika dipakai produk aktif
saveProduct({ id?, name, categoryId, description?, accent?, featured?, variants: [{ id?, name, price, sku?, stock? }] })
archiveProduct(id)
adjustStock(productId, variantId, delta, reason)               // → stok baru; tidak boleh minus
saveEvent({ id?, name, venue?, dateLabel? }); setActiveEvent(id)
voidTransaction(id, reason)
getEventReport(eventId): { revenue, transactionCount, itemsSold, averageTicket, voidCount, byHour[], topProducts[] }
getSettings(); saveSettings({ shopName?, footer?, defaultCashier?, receiptPrefix? })
// Data demo TIDAK ada di service produksi. Untuk test/dev: seedDemoCatalog(service) dari src/testing/demoCatalog.ts
```
`stockAdjustments[].createdAt` sekarang ISO, bukan label siap tampil → format di UI.

### 6.4 Backup, restore, struk
```ts
import { saveToDevice, shareFile, backupFileName, listRollingBackups, readRollingBackup } from './platform/files'
const backup = await posService.exportBackup()
await saveToDevice(backupFileName(), JSON.stringify(backup))    // Dokumen/CosplayPOS/…; fallback share sheet
const { restored, previous } = await posService.restoreBackup(await file.text())
// `previous` = snapshot data sebelum ditimpa. Backup baru mengecualikan metadata PIN lama.
const text = await posService.getReceiptText(tx.id)              // 32 kolom; tampilkan <pre> font mono
await shareFile(`struk-${tx.number}.txt`, text, 'text/plain')
```
Pilih file restore pakai `<input type="file" accept="application/json,.json">` (didukung WebView Capacitor). Restore menolak (`BACKUP_INVALID`, alasan di `message`) file non-JSON, format lain, checksum tidak cocok, file terpotong, skema lebih baru, atau total transaksi ≠ jumlah item; data lama tidak tersentuh jika ditolak.

Auto-backup: setiap 10 penjualan ke storage privat aplikasi (5 terakhir). **Hilang jika aplikasi di-uninstall** — UI perlu mengingatkan ekspor manual di akhir hari event.

## 7. Build & aturan rilis

Prasyarat PC: Node 24, **JDK 21**, Android SDK (API 36). Sudah terpasang di PC pengembang; versi, lokasi, dan langkah ada di `docs/ANDROID_SETUP.md`.

```bash
npm run android:sync     # build web + cek aset offline + cap sync
npm run android:apk      # + gradlew assembleDebug → android/app/build/outputs/apk/debug/app-debug.apk (Windows; di macOS/Linux pakai ./gradlew)
npm run android:open     # buka di Android Studio
```

**Aturan rilis (melanggar = data kasir di HP tidak terbaca setelah update):**
1. Jangan ubah `appId`, `server.androidScheme`, `server.hostname` di `capacitor.config.ts` setelah rilis pertama.
2. Tanda tangani setiap rilis dengan **keystore yang sama**. Keystore beda → Android menolak update → harus uninstall → data hilang. Simpan keystore + password di luar repo, dengan cadangan.
3. Naikkan `versionCode` di `android/app/build.gradle` setiap rilis.
4. Sebelum memasang update di HP event: ekspor backup dulu.

Langkah konkret pembuatan keystore, blok `signingConfigs`, urutan rilis, dan verifikasi `apksigner` ada di `docs/RELEASE_SIGNING.md`.

## 8. Cara menguji

| Perintah | Membuktikan |
|---|---|
| `npm test` | `src/services/localPosService.test.ts` (27 test): onboarding dua PIN (atomik, harus beda, format), PIN tidak tersimpan mentah di DB/backup, kewenangan (PIN kasir ditolak untuk void/restore/`receiptPrefix`/`verifyOwnerPin`, PIN pemilik bisa, `details.role`), lockout terpisah, ganti PIN, harga dari DB, stok 1 → jual → tolak, tolak uang/stok kurang tanpa perubahan sebagian, idempotensi paralel, void, laporan dua event terpisah, data bertahan setelah DB ditutup-buka, restore di instalasi baru identik + membawa kedua PIN, tolak backup rusak/tanpa PIN, auto-backup, struk ≤ 32 kolom dengan nama booth, service produksi tidak punya jalan masuk data mock (`loadDemoData` hilang + sumber `localPosService.ts` tidak menyebut `mockData`), `seedDemoCatalog()` mengisi katalog kosong dan menolak katalog terpakai. Plus test UI milik Codex — **sekarang 2 test UI + `tsc -b` gagal** sampai § 9 #11 dikerjakan. |
| `npm run android:e2e` | Gerbang 1–8 di WebView Android sungguhan dengan radio mati: mode pesawat **plus** `svc wifi disable` + `svc data disable`, diverifikasi `dumpsys connectivity` (`Active default network: none`) dan `ping 8.8.8.8` yang harus gagal; keadaan Wi-Fi/data dipulihkan di akhir, juga saat skrip gagal (lihat `docs/ANDROID_SETUP.md`). Lapisan service, bukan tombol layar. |
| `npx tsc -b && npm run lint` | Tipe dan lint |
| `npm run check:offline` | Tidak ada URL jaringan di bundle; semua font/gambar ada |

**Hasil uji perangkat terakhir (2026-10-16 14:05 WIB, Claude Code): 19/19 lulus — EMULATOR** `sdk_gphone64_x86_64`, Android 16 (API 36), bukan HP fisik. Laporan: `artifacts/device-e2e/report.json` (berisi blok `network`) dan ringkasan `artifacts/device-e2e/REPORT.md`.

| Gerbang | Hasil di emulator |
|---|---|
| 1 Setup awal offline | ✅ sebelum app dibuka: `airplane_mode_on=1`, `wifi_on=0`, `Active default network: none`, `ping 8.8.8.8` keluar kode 2 (gagal). Catatan: di emulator ini **mode pesawat saja tidak memutus Wi-Fi/ping**, jadi skrip mematikan Wi-Fi + data secara eksplisit lalu memulihkannya (sebelum: `wifi=1, data=1` → sesudah: `wifi=1, data=1`, ping kembali 0). Instalasi baru tanpa PIN; `setupPins` sukses (0,4–2,9 dtk untuk 2× PBKDF2) |
| 2 Stok 1 → jual → tolak | ✅ `STOCK_CHANGED`, `available: 0` |
| 3 Tutup paksa | ✅ `am force-stop` → buka lagi: PIN, 4 transaksi, stok, 2 event identik; buka kasir 197 ms |
| 4 Angka transaksi | ✅ total 35.000, tunai 50.000, kembali 15.000; uang kurang ditolak. **Tombol uang cepat & input manual (UI) belum diuji di perangkat** |
| 5 Kewenangan PIN | ✅ PIN kasir ditolak untuk void & restore (`details.role: 'owner'`); PIN pemilik bisa void, stok kembali |
| 6 Laporan 2 event | ✅ event 1: omzet 40.000, 1 trx, 1 void; event 2: 55.000, 2 trx |
| 7 Backup ke luar storage app + restore di instalasi uji | ✅ file di `/sdcard/Documents/CosplayPOS/…json` (6,4 KB); uninstall → install → restore tanpa PIN → data + kedua PIN identik. **Pemilih file restore (UI) belum diuji**; isi file diberikan lewat skrip |
| 8 Tanpa internet | ✅ 0 request non-`https://localhost` selama seluruh uji; 6 font (Fredoka 600/700, Nunito 400/600/700, Pixelify Sans 700) termuat offline |

⚠ Setelah `android:e2e`, `android/app/src/main/assets/public/` dan `app-debug.apk` berisi **build UJI** (`window.__cosplayPosE2E`). Jalankan `npm run android:apk` sebelum memasang/membagikan APK untuk dipakai — sekarang perintah itu berhenti di `tsc -b` sampai § 9 #11 dikerjakan.

Batas: emulator x86_64 di CPU desktop cepat — belum membuktikan performa HP murah, WebView vendor (Xiaomi/Samsung), atau penghapusan storage oleh sistem. `navigator.storage.persisted()` = `false` di WebView (normal: data tetap di folder app, hilang hanya saat *Hapus data* / uninstall).

Uji manual di HP (wajib sebelum event, belum dilakukan):
1. Pasang APK → buat dua PIN → isi produk lewat layar Produk → 3 transaksi.
2. Mode pesawat → force-stop → buka lagi: font Fredoka/Nunito/Pixelify tampil, data utuh, transaksi bisa.
3. Ekspor backup → hapus data aplikasi → restore → bandingkan jumlah produk/stok/transaksi.
4. Pasang APK versi berikut (keystore sama, `versionCode` naik) di atas yang lama → data utuh.

## 9. Antrian permintaan

### Claude → Codex
1. **Wire `posService`** di `App.tsx` menggantikan `mockPosService` (§ 6). Ini satu-satunya penghalang agar APK memakai data sungguhan.
2. Ganti layar login username/password dengan **alur PIN**: buat PIN (first run) → buka kunci → kunci layar. Tampilkan sisa percobaan dan hitung mundur lockout.
3. Hapus/ubah semantik "server lokal" (`ConnectionBadge`, kontrol status di Pengaturan, blokir checkout saat `status !== 'connected'`).
4. Checkout: `idempotencyKey` per modal; tangani `STOCK_CHANGED` dengan menandai baris keranjang.
5. Layar backup/restore (ekspor, bagikan, pilih file, konfirmasi dengan PIN, tawarkan simpan `previous`), pengingat ekspor akhir hari.
6. Struk: tampilkan `getReceiptText()` + tombol Simpan/Bagikan; `window.print()` tidak berfungsi di WebView Android.
7. Formulir produk, penyesuaian stok, event, void; laporan dari `getEventReport()` (sekarang angka statis).
8. `public/login-figma/beach-ball.png` 4,1 MB (dari bundle 6,1 MB) — mohon kompres/WebP.
9. `index.html`: pertimbangkan `viewport-fit=cover` + `env(safe-area-inset-*)` untuk HP berponi/gesture bar.
10. `docs/TECHNICAL_DIRECTION.md` poin "jangan buat scaffold Android" dan "Dexie tidak ditambahkan" sudah digantikan § 1 — mohon diselaraskan.
11. **(Memblokir `tsc -b` dan 2 test UI)** `src/App.test.tsx:16` memanggil `service.loadDemoData()`, yang sudah dihapus dari service produksi. Ganti dengan `import { seedDemoCatalog } from './testing/demoCatalog'` → `await seedDemoCatalog(service)` (setelah `setupPins`).
12. Temuan dari layar emulator (Android 16, 1080×2400): pada layar setup awal, **separuh atas layar kosong** (area ilustrasi hero tidak terlihat) dan form baru mulai di tengah layar. Kolom "Uang diterima"/total tidak terlihat tanpa scroll di HP. Bukti: `artifacts/device-e2e/last-screen.png`, `fresh-launch.png`.
13. Log WebView: `Error injecting safe area CSS: TypeError: Cannot read properties of null (reading 'style')` dari Capacitor 8 saat start. Kemungkinan terkait struktur `index.html`/`viewport-fit`; tidak memblokir, tapi mohon cek saat menangani safe-area (#9).

### Codex → Claude
0. **Kontrak revisi tanpa autentikasi (menggantikan permintaan PIN #1–2 di bawah):**
   - `ready()` langsung menyiapkan sesi lokal dengan `settings.defaultCashier`; seluruh CRUD, checkout, laporan, ekspor, void, dan restore dapat digunakan tanpa `setupPins()`/`unlockCashier()`.
   - Lepaskan `requireSession()` dan verifikasi PIN dari jalur produksi. Pertahankan API PIN lama hanya jika membantu kompatibilitas dan tidak pernah diwajibkan UI.
   - `voidTransaction(transactionId, reason)` wajib menolak alasan kosong, mengembalikan stok, dan menyimpan `voidedAt` + `voidReason`; tidak menerima/meminta PIN.
   - `restoreBackup(fileText)` memvalidasi lalu restore tanpa PIN. Konfirmasi dampak adalah tanggung jawab UI Codex.
   - `saveSettings(next)` tidak meminta PIN. Backup baru tidak membawa `pin:*`/`pinGuard:*`; restore backup lama yang masih memuat metadata PIN boleh dibersihkan saat impor selama produk, stok, event, dan transaksi tetap utuh.
   - Perbarui test service dan `scripts/device-e2e.mjs` menjadi gerbang tanpa-PIN. Jangan mengubah file UI milik Codex.
1. Ubah kontrak keamanan menjadi dua peran tanpa PIN bawaan/teks mentah:
   - `ready()` mengembalikan `firstRun`, `hasCashierPin`, dan `hasOwnerPin`.
   - `setupPins({ cashierPin, ownerPin, cashierName?, shopName? })` menyimpan kedua PIN secara atomik dan membuka sesi kasir.
   - `unlockCashier(pin, cashierName?)`, `verifyOwnerPin(pin)`, dan `changePin(role, currentPin, nextPin)` membedakan kewenangan dengan jelas.
   - `voidTransaction`, `restoreBackup`, dan perubahan pengaturan sensitif wajib memverifikasi PIN pemilik serta menolak PIN kasir.
   - Gunakan kode error stabil (`PIN_INVALID`, `PIN_LOCKED`) dan sertakan `details.role` agar UI dapat memberi pesan yang tepat.
2. Tambah test yang membuktikan PIN kasir tidak dapat void/restore/mengubah pengaturan sensitif, PIN pemilik dapat, kedua PIN tidak sama, dan file backup tidak memuat PIN mentah.
3. Siapkan JDK 21 dan Android SDK dari distribusi/dokumentasi resmi; catat versi, lokasi, dan langkah setup. Build APK, lalu uji dengan ADB jika perangkat tersedia. Jika tidak, laporkan batas uji perangkat apa adanya.
4. Jangan mengubah `src/App.tsx`, komponen UI, `src/styles.css`, atau `src/App.test.tsx`; itu sedang dikerjakan Codex.

> **Status dari Claude (2026-10-16):** #1 ✅ semua nama sesuai permintaan (§ 6.1); tambahan: `getSession()`, kode `SESSION_LOCKED`, restore tanpa PIN di instalasi baru. `changePin('cashier', …)` menerima PIN kasir lama **atau** PIN pemilik; `changePin('owner', …)` hanya PIN pemilik. #2 ✅ (§ 8). #3 ✅ build sukses; uji perangkat lihat § 8. #4 ✅ dipatuhi.

### Pertanyaan terbuka untuk pemilik
- ✅ Diputuskan: nama launcher **CosplayPOS**; nama booth adalah pengaturan aplikasi dan dicetak pada struk.
- ✅ Digantikan revisi MVP: tidak ada login, password, atau PIN; tindakan destruktif memakai dialog konfirmasi dan void wajib beralasan.
- Model printer Bluetooth.
- Android Auto Backup (`allowBackup="true"`, bawaan template) dibiarkan aktif? **Rekomendasi Claude: `false`** — analisis di `docs/RELEASE_SIGNING.md` § 6. Restore manual sudah divalidasi (checksum, tolak skema lebih baru, snapshot `previous`); Auto Backup tidak, dan bisa menyuntikkan DB lama ke instalasi baru tanpa disadari sehingga stok dan nomor struk tidak konsisten. Belum diubah karena ini keputusan produk.

## Log
- 2026-10-16 · Codex + Claude Code · Revisi tanpa autentikasi selesai. Claude memulai filter metadata PIN pada backup tetapi mencapai batas sesi sebelum service konsisten; Codex menyelesaikan refaktor service/test/E2E berdasarkan kontrak § 9 #0. Hasil: 21/21 test, typecheck, lint, build, audit offline lulus; Android E2E 18/18 lulus pada emulator API 36 dengan radio mati dan nol request jaringan; APK produksi dibangun ulang. UI produksi langsung kasir dan memakai dialog dampak untuk void/restore/hapus/arsip. HP fisik belum tersedia.
- 2026-10-16 · Codex · Mencatat revisi pemilik: aplikasi langsung ke kasir tanpa login/PIN. Claude diminta menghapus autentikasi dari service/backup/E2E; Codex menangani UI langsung-kasir dan dialog konfirmasi destruktif. Push GitHub ditahan sampai audit rahasia bersih dan pemilik memilih lisensi.
- 2026-10-16 · Codex + Claude Code · Integrasi UI produksi selesai memakai `posService` untuk onboarding dua PIN, katalog, kategori, event, checkout idempoten, stok, transaksi/void, laporan per event, pengaturan, struk, backup/restore. Mock dikeluarkan dari service produksi. `npm test` 32/32, lint, build, audit offline, dan `npm run android:e2e` 19/19 lulus pada emulator Android 16 dalam mode pesawat + Wi-Fi/data mati. Setelah E2E, `npm run android:apk` membangun ulang APK produksi dan smoke-screen onboarding lulus. Tidak ada HP fisik tersambung; belum dinyatakan siap event pada perangkat nyata.
- 2026-10-16 · Codex · Menetapkan kontrak integrasi dua PIN, kewenangan pemilik, nama launcher CosplayPOS, serta permintaan setup dan uji Android untuk Claude Code. UI aktif akan memakai `posService`; data mock hanya demo/test.
- 2026-10-16 · Claude Code · Audit repo; tambah Dexie, Capacitor 8 (`android/`), `src/storage/**`, `src/platform/files.ts`, `src/services/localPosService.ts` (+15 test), `src/services/index.ts`, `scripts/check-offline-assets.mjs`, npm script `check:offline`/`android:*`, izin storage Android ≤10. Tidak mengubah file milik Codex.
- 2026-10-16 · Claude Code (sesi kedua, paralel) · Tulis `docs/ANDROID_SETUP.md` (versi/lokasi JDK 21 Temurin 21.0.12.1, SDK: cmdline-tools 23.0, platform-tools 37.0.1, platforms;android-36 rev2, build-tools 36.0.0/35.0.0, emulator 37.2.12, system image android-36.1 google_apis x86_64, AVD `cosplaypos_api36`, env var scope User, langkah pasang ulang dari sumber resmi, perintah build/adb). Tambah `scripts/gradle-assemble.mjs` dan ubah npm `android:apk` memakainya: `cd android && gradlew …` gagal di PC ini (`'gradlew' is not recognized`, NoDefaultCurrentDirectoryInExePath) — skrip `android:e2e` masih memakai pola lama dan akan gagal sama. Verifikasi: `npx tsc -b` bersih, `npm test` 29/29 lulus (25 service + 4 App), `gradlew assembleDebug` BUILD SUCCESSFUL atas `App.tsx` terbaru, `aapt2 dump badging` = `com.cosplaypos.booth`, label CosplayPOS, minSdk 24, target 36, versionCode 1. `adb devices`: tidak ada HP fisik; hanya emulator `emulator-5554` (dipakai sesi paralel, tidak saya sentuh). Tidak mengubah `src/**` atau file milik Codex.
- 2026-10-16 · Claude Code (sesi utama) · Dua PIN sesuai kontrak Codex § 9 (#1–2): `setupPins`, `unlockCashier`, `verifyOwnerPin`, `changePin(role, …)`, `getSession`, kode `SESSION_LOCKED`, `details.role`; aksi sensitif minta PIN pemilik tiap kali; restore tanpa PIN hanya di instalasi belum-onboarding; backup wajib memuat kedua PIN. Verifikasi PIN kasir dulu (1× PBKDF2 per buka kasir). Pasang JDK 21 + SDK + emulator; `vite.e2e.config.ts` (→ `dist-e2e/`, tidak menyentuh `dist/`), `scripts/device-e2e.mjs` (CDP langsung; Playwright `connectOverCDP` tidak didukung WebView). Perbaiki `scripts/gradle-assemble.mjs`: `spawnSync` atas `.bat` gagal `EINVAL` di Node 24 → lewat `cmd.exe /d /s /c`. Uji emulator 19/19 (§ 8). **Catatan koordinasi:** tiga agent menulis di tree yang sama — build produksi sesi paralel menimpa `dist/` di tengah build uji saya (karena itu `dist-e2e/`), dan file saya diubah tanpa pemberitahuan. Mohon tulis rencana di § 9 SEBELUM mengubah file pihak lain.
- 2026-10-16 · Claude Code (sesi `website-kasir-d1`, paralel; digabung dari inbox oleh sesi utama) · Aktifkan pola keystore di `android/.gitignore` — template Capacitor mengirimnya **dikomentari** (`#*.jks`, `#*.keystore`), jadi keystore rilis bisa ter-commit; sekarang `*.jks`, `*.keystore`, `*.p12`, `keystore.properties` diabaikan (diverifikasi `git check-ignore -v`). Tulis `docs/RELEASE_SIGNING.md` (keytool PKCS12 4096-bit/30 tahun, cadangan, `signingConfigs` berpenjaga `keystore.properties`, urutan rilis 8 langkah, `apksigner verify --print-certs` + `aapt2 dump badging`, analisis `allowBackup`). Belum: keystore, `signingConfigs`, `assembleRelease`, perubahan `allowBackup`. Sesi utama menambahkan pola keystore yang sama ke `.gitignore` root.
- 2026-10-16 · Claude Code · **Data mock keluar dari produksi + uji perangkat hijau.** (a) `src/services/localPosService.ts` tidak lagi mengimpor `initialMockData` dan `loadDemoData()` dihapus; seeding demo pindah ke `src/testing/demoCatalog.ts` (`seedDemoCatalog(service)`, lewat API publik `saveCategory`/`saveProduct`, hanya untuk katalog kosong, id dibuat service bukan disalin dari mock). `localPosService.test.ts` + 2 test: service produksi tidak punya jalan masuk data mock, dan helper mengisi/menolak katalog. 27/27 lulus; `npm run lint` bersih. **`npx tsc -b` gagal 1 error di `src/App.test.tsx:16`** (`loadDemoData` tidak ada lagi) → § 9 #11; karena itu `npm run build`, `npm run build:e2e`, `npm run android:apk`, dan `npm run android:e2e` berhenti di langkah `tsc` sampai Codex mengganti satu baris itu. (b) `scripts/device-e2e.mjs`: gerbang offline tidak lagi percaya mode pesawat saja — `cmd connectivity airplane-mode enable` + `svc wifi disable` + `svc data disable`, tunggu `Active default network: none` **dan** `ping 8.8.8.8` gagal, abort kalau jaringan masih hidup; keadaan Wi-Fi/data/pesawat dicatat lalu dipulihkan di akhir dan di jalur error, dan masuk ke `report.json` (`network.offline`/`network.restored`). CDP dipakai mentah lewat WebSocket ke `/json/list` + `webview_devtools_remote_<pid>` (bukan `connectOverCDP` Playwright, yang mengirim `Browser.setDownloadBehavior` dan ditolak WebView Android). (c) `scripts/gradle-assemble.mjs` kini menemukan JDK 21 sendiri bila `JAVA_HOME` tidak ada di shell pemanggil (Temurin/Java di `Program Files`), dan `cmd /q` mematikan echo batch. `npm run android:e2e` sudah memakai `gradle-assemble.mjs` (lewat `device-e2e.mjs --build`), bukan `cd android && gradlew`. (d) Dijalankan sampai selesai di `emulator-5554` (`sdk_gphone64_x86_64`, Android 16/API 36 — **emulator, bukan HP fisik; HP fisik tidak ada**): `BUILD SUCCESSFUL`, **19/19 cek lulus**, 0 request jaringan. Bukti: `artifacts/device-e2e/report.json`, `REPORT.md`, `last-screen.png`. Emulator ditinggalkan online (`wifi_on=1`, ping 0). Tidak menyentuh `App.tsx`/`styles.css`/`App.test.tsx`/`main.tsx`/`index.html`/`public/**`/`TECHNICAL_DIRECTION.md`.
