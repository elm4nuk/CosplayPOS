# Integrasi Frontend CosplayPOS

UI produksi mengakses data hanya melalui `posService` dari `src/services/index.ts`. Implementasi produksi adalah `localPosService` berbasis Dexie/IndexedDB; komponen tidak mengakses database langsung dan tidak memiliki fallback otomatis ke mock.

## Alur produksi

1. `ready()` menyiapkan database lokal dan event awal, lalu aplikasi langsung menampilkan kasir.
2. `getBootstrap()` memasok produk, kategori, event, transaksi, dan audit stok.
3. Checkout memakai `createTransaction()` dengan idempotency key. Harga dihitung ulang dari database dan pengurangan stok berlangsung atomik.
4. Void memakai `voidTransaction(id, reason)`, mengembalikan stok, serta menyimpan alasan dan waktu pembatalan.
5. Laporan dihitung oleh `getEventReport(eventId)` dari transaksi tersimpan yang tidak dibatalkan. Hasilnya mencakup `topProducts` dan `topCategories`; keadaan tanpa penjualan mengembalikan kedua daftar kosong.
6. Backup dan restore memakai service serta helper perangkat di `src/platform/files.ts`.

Tidak ada login, password, PIN onboarding, akun server, atau koneksi LAN pada MVP. Dialog konfirmasi untuk void, restore, arsip, dan penghapusan adalah tanggung jawab UI.

Flag produk `featured` adalah pilihan manual pengelola dan ditampilkan sebagai **Pilihan booth**. Istilah **Produk terlaris** dan **Kategori terlaris** hanya dipakai untuk ranking otomatis dari laporan event.

## Data demo

`mockPosService` dan `src/data/mockData.ts` hanya untuk demo/test. Test yang memerlukan katalog fiktif menggunakan `seedDemoCatalog()` dari `src/testing/demoCatalog.ts`; jalur produksi tidak menyisipkan data demo.
