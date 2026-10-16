# Checklist publikasi open source

Jalankan checklist ini sebelum setiap push publik atau rilis APK.

## Wajib bersih

- Keystore/signing: `*.jks`, `*.keystore`, `*.p12`, dan `keystore.properties` tidak boleh di-commit.
- Konfigurasi lokal: `android/local.properties`, `.env*`, token, kredensial, dan password tidak boleh di-commit.
- Data pengguna: file backup, ekspor transaksi, database, dan isi `artifacts/` tidak boleh di-commit.
- APK hasil build tidak di-commit; distribusikan lewat GitHub Releases setelah signing.
- `src/data/mockData.ts` hanya memuat nama produk, event, dan transaksi fiktif.
- Jalankan pencarian secret, `npm audit`, test, lint, build, dan `npm run check:offline`.

## Lisensi

Lisensi: **MIT** (dipilih pemilik repository, teks resmi di `LICENSE`). Dependensi tetap memakai lisensinya sendiri; aset gambar yang asal-usulnya tidak jelas (mis. `public/login-figma/`) tidak boleh di-commit.

## Signing Android

Ikuti `docs/RELEASE_SIGNING.md`. Keystore dan password disimpan di luar repository, dicadangkan secara terpisah, dan keystore yang sama digunakan untuk seluruh pembaruan aplikasi.
