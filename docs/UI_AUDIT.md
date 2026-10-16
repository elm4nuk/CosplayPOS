# Audit UI kasir — tablet, HP, dan landscape

Audit dilakukan 17 Oktober 2026 dengan Chrome headless terhadap aplikasi React sebenarnya. Katalog uji dimasukkan melalui `localPosService` pada sesi browser terisolasi; tidak ada data mock yang ditambahkan ke build produksi.

## Temuan dan perbaikan

| Temuan | Dampak | Perbaikan |
|---|---|---|
| Pada 761–959 px, sidebar 78 px dan keranjang 320 px menyisakan katalog efektif sekitar 350–560 px. | Tablet portrait turun menjadi satu kolom atau kartu terlalu padat. | Keranjang menjadi side sheet; katalog mendapat lebar penuh dan minimal dua kolom 240 px. Tombol di header selalu menampilkan jumlah serta total. |
| Sidebar ringkas menyembunyikan teks menu tanpa nama aksesibel. | Pembaca layar dan pengujian keyboard tidak dapat mengenali tombol. | Setiap tombol sidebar memiliki `aria-label` dan `aria-current`. |
| Nama produk/varian panjang dan harga jutaan dapat menekan kolom tombol. | Teks/angka berpotensi keluar kartu. | Anak grid dapat menyusut, teks membungkus aman, harga tabular, dan layout diuji dengan empat varian serta harga sampai Rp 9.999.999. |
| Kontrol kuantitas hanya 34×32 px. | Terlalu kecil untuk sentuhan cepat. | Target dinaikkan menjadi 44×44 px; kategori dan tombol ikon minimal 48 px. |
| Dialog bayar pada viewport pendek harus digulir sampai aksi akhir. | Keyboard layar dapat menyembunyikan kembalian/tombol simpan. | Dialog memakai `dvh`, konten tetap scrollable, dan aksi pembayaran sticky. Pada tinggi simulasi 430 px, input dan CTA terlihat; kembalian terlihat setelah satu gulir ke bawah. |
| Badge “Sering laku” bersumber dari flag manual `featured`. | Label menyiratkan perhitungan penjualan yang tidak terjadi. | Label diganti menjadi “Pilihan booth”; “Produk terlaris” hanya dipakai untuk ranking transaksi event. |

## Matriks verifikasi

| Viewport | Hasil katalog/keranjang | Overflow horizontal | Bukti |
|---|---|---:|---|
| 360×800 portrait | 2 kolom, keranjang bottom sheet | Tidak | [Screenshot](screenshots/360x800-phone.png) |
| 390×844 portrait | 2 kolom, keranjang bottom sheet | Tidak | [Screenshot](screenshots/390x844-phone.png) |
| 768×1024 portrait | 2 kolom, tombol total + side sheet | Tidak | [Katalog](screenshots/768x1024-tablet-portrait.png) · [Keranjang](screenshots/768x1024-tablet-cart-open.png) |
| 800×1280 portrait | 2 kolom, tombol total + side sheet | Tidak | [Screenshot](screenshots/800x1280-tablet-portrait.png) |
| 1024×768 landscape | 2 kolom + keranjang 320 px berdampingan | Tidak | [Screenshot](screenshots/1024x768-tablet-landscape.png) |
| 1280×800 landscape | 2 kolom + keranjang 350 px berdampingan | Tidak | [Screenshot](screenshots/1280x800-wide-landscape.png) |

Kasus tekanan layout: [nama panjang, banyak varian, harga besar, dan stok habis pada 768×1024](screenshots/768x1024-long-name-many-variants.png).

Pembayaran saat tinggi viewport dipangkas untuk mensimulasikan keyboard: [input + nominal cepat + CTA](screenshots/390x430-checkout-keyboard.png) dan [kembalian + CTA setelah digulir](screenshots/390x430-checkout-change.png). Otomasi kemudian memverifikasi dialog struk tersimpan dan tombol **Transaksi baru** kembali ke katalog dengan keranjang kosong.

Laporan otomatis setelah transaksi pertama: [produk dan kategori terlaris pada 1024×768](screenshots/1024x768-event-report.png).

## Batas audit

- Screenshot responsif diambil di browser desktop, bukan perangkat fisik.
- Perubahan orientasi disimulasikan dengan pergantian viewport portrait/landscape.
- Kemunculan keyboard disimulasikan dengan tinggi visual viewport 430 px; perilaku IME vendor Android tetap perlu smoke test di perangkat nyata.

## Hasil pengujian aktual

- `npm test`: 24/24 lulus.
- `npx tsc -b`, `npm run lint`, `npm run build`, dan `npm run check:offline`: lulus.
- Audit aset offline: 48 file, termasuk 43 file font, tanpa referensi jaringan.
- `npm audit --omit=dev --audit-level=moderate`: 0 kerentanan produksi. Audit penuh melaporkan 3 moderat pada tooling dev `@capacitor/cli → xcode → uuid`; saran otomatis memerlukan perubahan versi Capacitor sehingga tidak diterapkan diam-diam.
- `npm run android:e2e`: 18/18 lulus pada emulator `sdk_gphone64_x86_64`, Android 16/API 36, dengan mode pesawat + Wi-Fi/data mati dan nol request jaringan.
- `npm run android:apk`: build debug produksi berhasil setelah E2E, sehingga APK terakhir bukan build dengan hook pengujian.
- Tidak ada HP fisik tersambung. Pengujian layar memakai browser dan pengujian Android memakai emulator.
