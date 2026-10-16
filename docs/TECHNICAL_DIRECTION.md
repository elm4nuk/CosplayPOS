# Arah Teknis CosplayPOS

## Keputusan framework

- Pertahankan React + TypeScript sebagai fondasi UI.
- Pertahankan Capacitor pada source APK. Dependency `@capacitor/*`, `capacitor.config.ts`, dan proyek `android/` sudah tersedia; JDK 21 dan Android SDK 36 telah disiapkan sesuai `docs/ANDROID_SETUP.md`.
- Dexie/IndexedDB adalah penyimpanan produksi yang diputuskan untuk aplikasi satu HP ini. Seluruh UI aktif wajib mengaksesnya melalui `posService` dari `src/services/index.ts`; `mockPosService` hanya boleh dipakai oleh demo dan test.
- Skema database harus berkembang melalui migrasi Dexie yang teruji. Perubahan versi tidak boleh menghilangkan produk, kategori, event, transaksi, maupun stok yang sudah tersimpan.
- Semua font, ikon, dan ilustrasi penting harus lokal. Font memakai `@fontsource` dan ikon memakai `lucide-react`; jalur produksi tidak mengambil aset dari internet.

## Pemakaian referensi

| Referensi | Keputusan |
| --- | --- |
| openIndoPOS | Gunakan hanya sebagai referensi pola fitur: nominal tunai kontekstual, backup/restore eksplisit, dan pemilihan printer. Repository tidak menampilkan berkas lisensi, jadi jangan menyalin source. |
| Dexie.js | Menjadi fondasi database lokal produksi. Komponen UI tidak boleh mengakses Dexie langsung; seluruh operasi melewati `localPosService`/`posService`. |
| capacitor-community/sqlite | Opsi migrasi terencana untuk database native. Wajib ada uji upgrade yang mempertahankan transaksi, produk, dan stok lama. Tidak ditambahkan sekarang. |
| shadcn/ui | Ambil pola komponen aksesibel secara selektif. Jangan memasukkan Tailwind atau mengganti sistem komponen hanya demi konsistensi library. |
| UI/UX Pro Max | Menjadi dasar audit touch target, hierarki total/kembalian, aksesibilitas form, kepadatan layar HP, dan reduced motion. |

## Prioritas implementasi

1. Aplikasi langsung membuka layar kasir tanpa login, password, atau onboarding PIN. Tidak ada autentikasi yang menghambat checkout.
2. Seluruh UI produksi memakai `localPosService` melalui `posService`: produk, kategori, event, checkout, riwayat, stok, laporan, pengaturan, dan backup/restore. Data mock hanya untuk demo/test.
3. Checkout tunai cepat: total jelas, uang diterima harus dipilih sadar, nominal cepat tidak boleh kurang dari total, dan kembalian paling menonjol.
4. Void wajib meminta alasan dan menyimpannya pada riwayat. Void, restore, arsip, dan penghapusan memakai dialog yang menjelaskan dampak sebelum dijalankan.
5. Verifikasi persistence setelah force-close, audit aset tanpa jaringan, build APK dengan JDK 21/Android SDK resmi, lalu uji di perangkat melalui ADB bila tersedia.
6. Printer Bluetooth ditunda sampai alur inti dan gerbang data lulus; struk teks berbagi/simpan tetap tersedia secara offline.

## Gerbang migrasi database

Migrasi ke SQLite hanya boleh dilakukan jika ada kebutuhan native yang terukur. Sebelum rilis, uji upgrade harus membuktikan jumlah dan isi transaksi, produk, varian, serta stok sebelum dan sesudah pembaruan identik; kegagalan migrasi harus membatalkan perubahan tanpa menghapus database lama.
