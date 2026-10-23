# Pengujian di HP/tablet — CosplayPOS

Dokumen ini untuk siapa pun yang menyiapkan APK sebelum dipakai di event: apa yang sudah diuji otomatis, apa yang **wajib** diuji tangan di perangkat fisik, dan cara menjalankan uji upgrade APK. Aturan rilis (keystore, `appId`, `versionCode`) tetap di `docs/RELEASE_SIGNING.md` dan `docs/HANDOFF.md` § 7.

## 1. Yang sudah otomatis

| Perintah | Membuktikan | Lapisan |
|---|---|---|
| `npm test` | Service, migrasi Dexie v1→v2, backup/restore, intake gambar, alur UI (jsdom) | Node + jsdom, **bukan** WebView |
| `npm run android:e2e` | 18 gerbang di WebView Android sungguhan dengan radio mati (checkout, stok 1, void, laporan 2 event, backup ke Dokumen, force-stop, restore) | Service lewat CDP, bukan tombol layar |
| `node scripts/device-upgrade-e2e.mjs <lama.apk> <baru.apk>` | Data dari APK lama bertahan setelah APK baru dipasang di atasnya; migrasi skema berjalan di WebView; alur v2 (QRIS terkonfirmasi, bundle, void) jalan setelah upgrade; backup v1 bisa di-restore | Service lewat CDP |

Hasil terakhir (2026-10-23, Claude Code): `android:e2e` 18/18 dan uji upgrade 17/17 — keduanya di **emulator** `sdk_gphone64_x86_64` Android 16 (API 36). Belum ada HP fisik.

Ketiganya tidak menekan tombol layar. Semua yang menyangkut sentuhan, keyboard, kamera/galeri, rotasi, dan tampilan harus diuji tangan (§ 2).

## 2. Checklist HP/tablet fisik (wajib sebelum event)

Catat untuk setiap perangkat: merek/model, versi Android, versi WebView (`Pengaturan → Aplikasi → Android System WebView`), ukuran layar, dan hasil tiap baris (✅/❌ + catatan/screenshot). Uji minimal satu HP murah (RAM ≤ 4 GB) dan satu tablet.

Siapkan: APK rilis bertanda tangan (bukan build uji `android:e2e`), mode pesawat **dan** Wi-Fi/data mati, katalog berisi ≥ 30 produk dengan foto.

### 2.1 Checkout tunai
1. Tambah 3 produk berbeda, ubah jumlah, hapus satu baris.
2. Bayar: tombol uang cepat, "Uang pas", lalu ketik nominal manual. Uang kurang → tombol simpan nonaktif.
3. Simpan → struk muncul, stok berkurang, nomor struk berurutan.
4. Ketuk "Simpan pembayaran" dua kali cepat → hanya **satu** transaksi tercatat.
5. Jual stok terakhir sebuah varian → produk tidak bisa ditambah lagi.

### 2.2 QRIS (offline, tanpa gateway)
1. Unggah foto QRIS di Pengaturan; pastikan tampil tajam dan bisa di-scan dari HP lain (jarak 20–40 cm, kecerahan layar penuh).
2. Checkout QRIS: transaksi **tidak** tersimpan sebelum kasir menekan konfirmasi.
3. Tekan konfirmasi hanya setelah melihat notifikasi berhasil di HP pembeli. Struk/teks bagikan menulis **"QRIS — dikonfirmasi kasir"**, tidak pernah "terverifikasi".
4. Isi referensi opsional (mis. 4–6 digit terakhir). Nomor HP/rekening panjang harus ditolak.
5. Laporan event memisahkan omzet tunai vs QRIS.

### 2.3 Promo bundle
1. Buat bundle 2 produk; harga bundle < harga normal.
2. Terapkan di kasir → diskon yang tampil = harga normal − harga bundle; total tersimpan sama dengan yang tampil.
3. Ubah harga produk sampai bundle tidak lebih murah → checkout dengan bundle ditolak dengan pesan jelas.
4. Arsipkan salah satu produk bundle → bundle tidak bisa dipakai.

### 2.4 Rotasi dan ukuran layar
1. Putar layar di kasir, modal pembayaran, form produk, dan laporan. Isi keranjang, nominal yang sedang diketik, dan modal yang terbuka **tidak hilang**.
2. Tablet landscape dan HP portrait: total dan tombol bayar terlihat tanpa scroll berlebihan; tidak ada elemen terpotong poni/gesture bar.
3. Ukuran font sistem "Besar": teks tidak saling tumpuk.

### 2.5 Keyboard
1. Field nominal memunculkan keypad angka.
2. Keyboard tidak menutupi field yang sedang diisi (form produk, alasan void, referensi QRIS).
3. Tombol "Enter/Selesai" tidak mengirim form yang belum lengkap.
4. Tombol Back Android menutup keyboard/modal dulu, bukan keluar aplikasi.

### 2.6 Foto produk
1. Ambil dari kamera dan dari galeri: JPG, PNG, WebP; foto kamera 12–50 MP.
2. File HEIC (default sebagian iPhone/Samsung), GIF, atau file rusak → pesan error jelas, aplikasi tidak macet.
3. Setelah 30+ produk berfoto: buka ulang aplikasi (force-stop) — waktu sampai kasir siap dan kelancaran scroll dicatat.
4. Foto tetap muncul setelah backup → restore.

### 2.7 Event, arsip, dan sesi kas
1. Arsipkan event non-aktif yang punya transaksi → transaksi dan laporannya masih terbaca, event tidak bisa dipilih untuk jual.
2. Event aktif hanya bisa diarsipkan setelah memilih pengganti.
3. (Bila UI sudah ada) buka sesi kas → jual tunai/QRIS → tutup dengan uang aktual → selisih benar.

### 2.8 Backup dan restore
1. Ekspor backup → file ada di `Dokumen/CosplayPOS/` (lihat dengan aplikasi File).
2. Bagikan ke Drive/WhatsApp lewat share sheet.
3. Hapus data aplikasi (Pengaturan → Aplikasi → CosplayPOS → Hapus data) → buka → restore file tadi → jumlah produk, stok, transaksi, foto, bundle, event arsip sama.
4. Restore file yang rusak/terpotong → ditolak, data lama tetap.
5. Catat ukuran file backup dengan 30+ foto.

### 2.9 Upgrade APK (paling kritis untuk data)
1. Pasang APK rilis versi **sebelumnya**, isi data nyata (≥ 20 transaksi, foto, bundle, QRIS).
2. Ekspor backup (prosedur wajib sebelum update).
3. Pasang APK baru (keystore sama, `versionCode` lebih tinggi) **tanpa uninstall**.
4. Semua data utuh; transaksi QRIS lama terbaca sebagai "QRIS (data lama)"; transaksi baru bisa dibuat; void transaksi lama mengembalikan stok.
5. Bila Android menolak update ("App not installed"/konflik tanda tangan) → **jangan uninstall**; periksa keystore (`docs/RELEASE_SIGNING.md`).

## 3. Menjalankan uji upgrade APK

Butuh dua APK **build uji** (`window.__cosplayPosE2E`) yang ditandatangani kunci yang sama (di satu PC: debug keystore `~/.android/debug.keystore`).

```bash
# APK lama dari commit/tag sebelumnya, di worktree terpisah (tidak menyentuh tree kerja)
git worktree add --detach ../CosplayPOS-upgrade-base <commit-lama>
cd ../CosplayPOS-upgrade-base
npm ci                                   # atau junction node_modules bila package-lock sama
npm run build:e2e && rm -rf dist && cp -r dist-e2e dist
npx cap sync android                     # membuat capacitor.config.json/plugins yang tidak di-commit
node scripts/gradle-assemble.mjs assembleDebug
cp android/app/build/outputs/apk/debug/app-debug.apk <tmp>/lama-e2e.apk

# APK baru dari branch yang diuji
cd <repo>
npm run build:e2e && npx cap sync android
rm -rf android/app/src/main/assets/public && cp -r dist-e2e android/app/src/main/assets/public
node scripts/gradle-assemble.mjs assembleDebug

node scripts/device-upgrade-e2e.mjs <tmp>/lama-e2e.apk android/app/build/outputs/apk/debug/app-debug.apk
```

Hasil: `artifacts/device-upgrade/report.json` dan `REPORT.md`. Skrip meng-uninstall aplikasi di awal — **jangan jalankan di HP yang berisi data kasir sungguhan.** Setelah uji, aset Android berisi build uji: jalankan `npm run android:apk` sebelum membagikan APK.

## 4. Rencana: Appium + UiAutomator2 (belum dipasang)

Belum ditambahkan ke repo: butuh server Appium, driver UiAutomator2, dan dependensi Node baru, sedangkan gerbang otomatis yang ada (`android:e2e`, uji upgrade) sudah stabil lewat CDP. Menambahkannya sekarang berisiko mengubah `package.json` bersama tanpa memberi bukti baru untuk lapisan data.

Bila UI sudah stabil, fondasi yang disarankan (folder terpisah `e2e-ui/`, tidak dijalankan oleh `npm test`):

1. Pasang global di PC uji, bukan dependensi proyek: `npm i -g appium` lalu `appium driver install uiautomator2`.
2. Klien WebdriverIO di `e2e-ui/package.json` sendiri. Capabilities: `platformName: Android`, `appium:automationName: UiAutomator2`, `appium:appPackage: com.cosplaypos.booth`, `appium:appActivity: .MainActivity`, `appium:noReset: true`.
3. Konten aplikasi ada di WebView: pindah konteks `WEBVIEW_com.cosplaypos.booth` (butuh build debug / `WebView.setWebContentsDebuggingEnabled`) untuk memilih elemen dengan role/label yang sama seperti `App.test.tsx`; konteks `NATIVE_APP` untuk dialog sistem (pemilih file, share sheet, izin storage), rotasi (`driver.setOrientation`), dan keyboard (`driver.isKeyboardShown`, `hideKeyboard`).
4. Skenario pertama: § 2.1 langkah 1–4, § 2.2 langkah 2–3, § 2.4 langkah 1, § 2.8 langkah 1–3.
5. Jangan pernah menjalankan di perangkat berisi data nyata (`noReset` + uninstall di awal suite).

## 5. Rencana: printer ESC/POS dan barcode (dokumentasi saja)

Menunggu model printer dan kebutuhan disetujui pemilik (`docs/HANDOFF.md` § 9 pertanyaan terbuka). Belum ada kode.

**Printer thermal 58 mm.** `formatReceiptText()` sudah 32 kolom tanpa DOM, siap dikirim ke driver. Yang perlu diputuskan: Bluetooth Classic (SPP, mayoritas printer murah) atau BLE; plugin Capacitor yang dipilih (cek lisensi dan dukungan Capacitor 8); izin Android 12+ `BLUETOOTH_CONNECT`/`BLUETOOTH_SCAN`; codepage untuk karakter seperti "—" (fallback ke "-"); perilaku bila printer mati di tengah cetak (transaksi tetap tersimpan, cetak ulang dari riwayat). Uji wajib: 20 struk berturut-turut, kertas habis, printer dimatikan, pairing ulang.

**Barcode.** Opsi: (a) scanner Bluetooth/USB mode keyboard (HID) — tanpa kode native, cukup field fokus + pencarian SKU; (b) kamera — butuh plugin + izin kamera, lebih lambat di booth ramai. Rekomendasi awal: (a). Butuh: indeks SKU unik per varian (sekarang `sku` opsional dan tidak unik), aturan bila SKU tidak ditemukan, dan uji dengan scanner yang benar-benar dibeli.
