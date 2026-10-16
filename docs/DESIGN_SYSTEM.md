# Design System — CosplayPOS

Dokumen ini adalah sumber keputusan visual frontend untuk kasir booth cosplay. Arah awal dihasilkan dan diaudit dengan UI/UX Pro Max 2.15.0 melalui kueri `creative convention retail POS playful fast`, lalu disesuaikan untuk lingkungan booth: pencahayaan ramai, antrean cepat, perangkat sentuh, dan operator yang perlu memindai informasi dalam hitungan detik.

## Prinsip

1. **Ceria tanpa berisik.** Permukaan krem hangat dan tinta gelap menjaga keterbacaan; pink hanya menandai merek dan aksi utama.
2. **Kecepatan di atas dekorasi.** Produk, stok, harga, total, dan status penyimpanan lokal selalu lebih menonjol daripada ornamen.
3. **Satu aksi utama per konteks.** Pada katalog: tambah barang. Pada keranjang: Bayar. Pada checkout: Simpan pembayaran.
4. **Status tidak bergantung warna.** Koneksi, stok, validasi, dan transaksi selalu memiliki ikon atau teks.
5. **Playful yang orisinal.** Ilustrasi memakai bentuk geometris dan maskot abstrak buatan sendiri; tidak memakai karakter atau logo anime pihak lain.

## Warna

| Token | Nilai | Pemakaian |
|---|---:|---|
| `--ink` | `#24212B` | Teks utama, sidebar, kategori aktif |
| `--muted-ink` | `#625E6D` | Teks sekunder yang tetap lolos kontras pada permukaan terang |
| `--surface` | `#FFFDFB` | Kartu, panel, dialog |
| `--canvas` | `#FFF8F1` | Latar hangat agar booth terasa ramah |
| `--line` | `#E8DFD8` | Batas komponen |
| `--pink` | `#D92F75` | CTA dan identitas utama |
| `--pink-dark` | `#A91455` | Bayangan CTA dan teks aksen dengan kontras lebih tinggi |
| `--purple` | `#7653D6` | Focus ring; dibedakan dari CTA |
| `--mint` / `--mint-soft` | `#168776` / `#DEF7EF` | Sukses, tersimpan lokal, stok aman |
| `--amber` / `--amber-soft` | `#A96800` / `#FFF0C7` | Peringatan dan stok menipis |
| `--red` / `--red-soft` | `#C52F36` / `#FFE5E7` | Error, offline, tindakan berbahaya |

Warna fungsional selalu ditemani label. Teks normal ditargetkan minimal WCAG AA 4.5:1 dan kontrol/focus indicator minimal 3:1 terhadap warna sekitar.

## Tipografi

- Heading/merek: **Fredoka 600–700**. Bentuk bulat memberi karakter kreatif tanpa mengganggu angka transaksi.
- Isi/UI: **Nunito 400–700**. Ramah, kompak, dan jelas pada tablet.
- Skala: 12, 14, 16, 18, 24, 32 px; isi tidak boleh di bawah 16 px pada input HP.
- Harga, stok, total, dan nomor transaksi memakai `font-variant-numeric: tabular-nums` agar tidak bergeser.
- Panjang paragraf dibatasi; nama produk boleh membungkus dan tidak dipotong tanpa jalan untuk membaca nilai penuh.

## Spacing, radius, dan elevasi

- Basis spacing 4 px, dengan langkah utama 8, 12, 16, 24, 32 px.
- Radius kecil 10 px, sedang 16 px, besar/dialog 24 px.
- Kartu memakai bayangan kecil `0 2px 0 rgba(...)`; dialog memakai elevasi lebih kuat. Tidak memakai glassmorphism dekoratif.
- Desktop memiliki gutter 24 px; HP 14 px.

## Komponen

### Tombol

- Tinggi tombol utama minimum 48 px untuk Android; aksi kecil sekunder minimal 44 px dan tetap diberi jarak aman.
- Primary: pink, teks putih, bayangan bawah gelap sebagai feedback tekan.
- Secondary: permukaan putih, border netral.
- Disabled: atribut native `disabled`, opacity 45%, tanpa bayangan.
- Loading: label berubah dan spinner muncul; ukuran tombol tetap.

### Kartu produk

- Area ilustrasi geometris orisinal, nama, deskripsi singkat, lalu varian.
- Setiap baris varian menampilkan nama, harga, dan stok; satu tap menambah varian itu.
- Produk/varian habis memakai `disabled`, teks “Habis”, dan opacity lebih rendah.
- **“Pilihan booth”** berasal dari flag manual `featured`; label ini tidak boleh disebut “Sering laku” karena bukan hasil transaksi.
- Produk terlaris otomatis hanya tampil di Laporan dan dihitung dari transaksi event yang tidak dibatalkan.

### Keranjang dan checkout

- Desktop dan tablet lebar (`≥960px`): panel keranjang berdampingan bila katalog masih mendapat ruang untuk dua kolom nyaman.
- Tablet sempit (`761–959px`): katalog memakai lebar penuh di samping sidebar ringkas. Tombol keranjang di header selalu memperlihatkan jumlah barang dan total; keranjang terbuka sebagai side sheet.
- HP (`≤760px`): tombol Keranjang berada di bottom navigation; isi muncul sebagai bottom sheet.
- Quick cash dihitung kontekstual dari total, selalu mencakup Uang pas, dan input manual memakai keypad numerik.
- Pembayaran kurang menampilkan nominal kekurangan dan menonaktifkan submit.
- Tombol bayar dinonaktifkan selama request; dialog sukses hanya muncul setelah service mengembalikan transaksi tersimpan.
- Saat keyboard terbuka atau orientasi berubah, dialog pembayaran mengikuti `dvh`, kontennya dapat digulir, dan baris aksi Simpan tetap sticky di tepi bawah area terlihat.

### Status

| Status | Presentasi |
|---|---|
| Data lokal siap | Ikon check + teks “Tersimpan di perangkat” + mint |
| Sukses transaksi | Check, nomor transaksi, rincian, tunai, kembalian |
| Error | `role="alert"`, sebab singkat, dan langkah pemulihan |

### Tabel dan grafik

- Tabel menggunakan header jelas, angka tabular, status berlabel, dan scroll horizontal pada HP.
- Laporan memakai bar chart sederhana untuk perbandingan waktu dan selalu memiliki ringkasan teks. Data kategori terlaris juga tersedia sebagai ranking tekstual.
- Ekspor ditampilkan sebagai aksi sekunder.

## Responsivitas

- `≤760px`: bottom navigation maksimal lima item, katalog dua kolom fleksibel, keranjang bottom sheet, dialog melekat ke bawah untuk jangkauan ibu jari.
- `761–959px`: sidebar ringkas, katalog minimal dua kolom 240 px, dan keranjang side sheet lewat tombol total yang selalu terjangkau.
- `960–1050px`: sidebar ringkas, katalog dua kolom, dan panel keranjang 320 px berdampingan.
- `>1050px`: sidebar berlabel, katalog adaptif, dan panel keranjang 350 px.
- Breakpoint diturunkan dari kebutuhan ruang nyata: sidebar + dua kartu katalog + gutter + panel keranjang. Orientasi tidak menjadi satu-satunya sinyal.
- Validasi wajib pada 360, 390, 768, 800, 1024, dan 1280 px dalam orientasi relevan; halaman kasir tidak boleh memiliki scroll horizontal.
- Fixed navigation, tombol keranjang, sheet, modal, dan CTA menghormati `env(safe-area-inset-*)`.

## Motion dan aksesibilitas

- Transisi feedback 160–200 ms; tidak ada animasi yang menunda input.
- Animasi hanya memakai opacity/transform dan `prefers-reduced-motion` menonaktifkannya.
- Focus ring 3 px selalu terlihat, urutan tab mengikuti urutan visual, dan shortcut F2 hanya menambah jalur—bukan menggantikan tombol.
- Form memiliki label eksplisit, error inline/announced, dan input pembayaran `inputmode="numeric"` dengan ukuran teks aman dari auto-zoom.
- Ikon memakai Lucide secara konsisten; ikon dekoratif diberi `aria-hidden`, tombol ikon memiliki accessible name.

## Anti-pattern yang dihindari

- Dashboard abu-abu korporat generik, neon berlebihan, gradien AI ungu-pink, glass blur dekoratif, dan layar penuh KPI saat kasir bekerja.
- Emoji sebagai ikon struktur.
- Informasi yang hanya dibedakan warna.
- Animasi panjang, hover-only, target kecil, atau success optimistis sebelum transaksi lokal benar-benar tersimpan.
