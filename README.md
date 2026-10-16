# CosplayPOS

Kasir Android offline untuk satu HP booth kreator/cosplay. Aplikasi dibangun dengan React, TypeScript, Capacitor, dan Dexie; pengguna langsung masuk ke layar kasir tanpa akun, server, atau PIN.

## Fitur MVP

- Produk, kategori, varian, stok, dan event tersimpan lokal.
- Checkout tunai dengan nominal cepat, input manual, dan kembalian.
- Riwayat transaksi; pembatalan wajib menyimpan alasan dan mengembalikan stok.
- Laporan terpisah per event, termasuk produk dan kategori terlaris dari transaksi yang tidak dibatalkan.
- Ekspor dan restore backup JSON dengan validasi.
- Font, ikon, dan alur utama tersedia tanpa internet.

Data pada `src/data/mockData.ts` sepenuhnya fiktif dan hanya dipakai helper demo/test. Build produksi menggunakan `localPosService`.

## Menjalankan dan menguji

Prasyarat: Node.js 24. Untuk APK, ikuti versi JDK 21 dan Android SDK pada `docs/ANDROID_SETUP.md`.

```bash
npm install
npm run dev
npm test
npm run lint
npm run build
npm run check:offline
npm run android:apk
```

APK debug dihasilkan di `android/app/build/outputs/apk/debug/app-debug.apk`. APK debug hanya untuk pengujian; prosedur signing rilis ada di `docs/RELEASE_SIGNING.md` dan keystore tidak boleh disimpan di repository.

## Arsitektur dan dokumentasi

- Arah teknis: `docs/TECHNICAL_DIRECTION.md`
- Kontrak kerja Codex/Claude: `docs/HANDOFF.md`
- Setup Android: `docs/ANDROID_SETUP.md`
- Design system: `docs/DESIGN_SYSTEM.md`

## Lisensi

[MIT](LICENSE). Dependensi pihak ketiga memakai lisensinya masing-masing (mis. Dexie: Apache-2.0, Capacitor: MIT, font Fredoka/Nunito/Pixelify Sans: SIL Open Font License via `@fontsource`).
