# Panduan Operasional (Windows) — Kasir Booth Cosplay

Untuk operator booth. Satu laptop Windows menjadi **server**; HP/tablet/laptop lain menjadi **kasir** lewat Wi-Fi yang sama. Internet **tidak** dibutuhkan saat event.

```
 [HP Kasir 1] ──┐
 [HP Kasir 2] ──┼── Wi-Fi router (tanpa internet pun tidak apa-apa) ──── [Laptop server: Node.js + data\pos.db]
 [Tablet admin]─┘
```

---

## A. Persiapan di rumah (butuh internet, sekali saja)

1. Pasang **Node.js 24 LTS** dari https://nodejs.org (pilih "Windows Installer (.msi)", centang semua opsi bawaan).
2. Salin folder proyek ke laptop, mis. `D:\kasir`.
3. Buka folder itu, klik dua kali **`start-server.bat`**. Pertama kali ia akan mengunduh dependensi (`node_modules`). Setelah muncul kotak "server lokal berjalan", tekan `Ctrl+C` untuk berhenti.
   - Atau lewat PowerShell: `npm install` lalu `npm start`.
4. Buka firewall untuk HP kasir — PowerShell **Run as administrator**:
   ```powershell
   cd D:\kasir
   powershell -ExecutionPolicy Bypass -File scripts\windows-firewall.ps1
   ```
5. (Opsional, untuk latihan) isi data demo: `npm run seed:demo`.
6. Jalankan server, buka `http://localhost:3000` di laptop, login sebagai `admin` / `admin123`, lalu **ganti password admin**. Buat akun kasir, event, kategori, dan produk + stok awal.
7. **Uji coba tanpa internet**: cabut internet/matikan data seluler router, pastikan HP masih bisa login dan checkout (lihat bagian D).

> Setelah `node_modules` terpasang, server tidak pernah butuh internet lagi. Jangan hapus folder `node_modules`.

## B. Jaringan di venue

- Pakai **router Wi-Fi sendiri** (router portable/mini router). Router tidak perlu tersambung internet.
- Hotspot HP bisa dipakai sebagai cadangan, tetapi sebagian HP mengaktifkan *client isolation* (perangkat tidak bisa saling melihat) — uji dulu.
- Wi-Fi venue umum biasanya memblokir koneksi antar perangkat → **jangan dipakai**.
- Atur di router: **DHCP reservation / IP statis** untuk laptop server (mis. `192.168.0.10`) agar alamat tidak berubah tiap hari.
- Beri password WPA2 pada Wi-Fi: lalu lintas kasir memakai HTTP biasa di dalam LAN.
- Laptop: Settings → Network → Wi-Fi → pilih jaringan → **Network profile type: Private**.

## C. Hari event — menyalakan server

1. Colokkan charger laptop. Settings → System → Power: **Sleep = Never** saat dicolok (laptop yang tidur = server mati).
2. Sambungkan laptop ke Wi-Fi router booth.
3. Klik dua kali `start-server.bat`. Jendela hitam menampilkan alamat, contoh:
   ```
    Dari HP/tablet (Wi-Fi yang sama):
      http://192.168.0.10:3000
   ```
   **Jangan tutup jendela ini** selama berjualan.
4. Di admin: pastikan event hari itu berstatus **Aktif** (hanya satu event aktif dalam satu waktu).
5. Di setiap HP kasir: sambungkan ke Wi-Fi yang sama → buka browser (Chrome) → ketik alamat di atas → login dengan akun kasir masing-masing. Tips: "Add to Home screen" agar mudah dibuka lagi.

Jika alamat tidak terbuka dari HP:
- Pastikan HP & laptop di Wi-Fi yang sama (bukan data seluler).
- Jalankan ulang `scripts\windows-firewall.ps1` sebagai administrator.
- Cek alamat IP laptop: PowerShell `ipconfig` → "Wireless LAN adapter Wi-Fi" → IPv4 Address.
- Matikan VPN di laptop.

## D. Uji "internet mati" (lakukan sebelum event dan pagi hari event)

1. Matikan internet router (cabut kabel WAN / matikan SIM), Wi-Fi tetap menyala.
2. Dari 2 HP: login, buka katalog, checkout 1 transaksi masing-masing, lihat stok berkurang di HP lain.
3. Dari laptop/tablet admin: buka laporan event — transaksi tadi muncul.
4. Uji otomatis dari laptop (server sedang jalan, akun `kasir1`/`kasir2` ada):
   ```powershell
   npm run smoke:lan -- http://192.168.0.10:3000
   ```
   Harus berakhir dengan `HASIL: SEMUA LULUS`. Skrip membuat produk uji, lalu men-void transaksinya & menonaktifkan produk itu.

## E. Backup

Database: **`data\pos.db`** (satu file, termasuk gambar produk).

| Jenis | Kapan | Lokasi |
|---|---|---|
| Otomatis | tiap 10 menit jika ada perubahan, dan saat server dihentikan dengan `Ctrl+C` | `data\backups\pos-…-auto.db` (60 terakhir disimpan) |
| Manual (web) | Admin → Backup → "Buat backup" lalu "Download" | `data\backups\pos-…-manual.db` / folder Download perangkat |
| Manual (CLI) | `npm run backup` — aman saat server berjalan | `data\backups` |
| Ke flashdisk | `npm run backup -- E:\backup-kasir` | `data\backups` + `E:\backup-kasir` |

**Rutinitas yang disarankan:** setiap akhir hari event → `npm run backup -- E:\backup-kasir` (flashdisk), dan download satu backup ke HP admin.

**Salinan otomatis ke folder lain** (flashdisk atau folder Google Drive/OneDrive yang tersinkron saat ada internet): set variabel sebelum menjalankan server, mis. buat file `start-server-mirror.bat`:
```bat
@echo off
set POS_BACKUP_MIRROR_DIR=E:\backup-kasir
call "%~dp0start-server.bat"
```

Pengaturan lain (opsional, variabel lingkungan): `POS_PORT` (default 3000), `POS_AUTO_BACKUP_MINUTES` (default 10, 0 = mati), `POS_AUTO_BACKUP_KEEP` (default 60), `POS_TIMEZONE` (default `Asia/Jakarta`; WITA = `Asia/Makassar`, WIT = `Asia/Jayapura`), `POS_DATA_DIR` (default `data`), `POS_SESSION_HOURS` (default 18), `POS_ADMIN_PASSWORD` (password admin awal saat database baru).

## F. Pemulihan (restore)

**Lewat web (server tetap jalan):** Admin → Backup → pilih backup → "Pulihkan", atau unggah file `.db`.
- Database saat ini otomatis disimpan dulu sebagai `pos-…-pre-restore.db` (jadi restore bisa dibatalkan dengan me-restore file itu).
- Semua perangkat akan logout — kasir login ulang.

**Lewat CLI (server dimatikan):**
```powershell
npm run restore -- --list
npm run restore -- pos-2026-10-17T10-30-00-000Z-auto.db
npm run restore -- E:\backup-kasir\pos-2026-10-17T10-30-00-000Z-manual.db
```
Lalu jalankan server lagi.

**Laptop server rusak/hilang di tengah event:**
1. Siapkan laptop lain dengan Node.js 24 + folder proyek (+ `node_modules`) — idealnya sudah disiapkan sebagai cadangan.
2. Salin backup terakhir dari flashdisk, `npm run restore -- E:\backup-kasir\<file>.db`.
3. Jalankan server, beri tahu kasir alamat IP baru (atau pakai DHCP reservation yang sama).
4. Transaksi setelah backup terakhir hilang dari sistem — cocokkan dengan struk/notifikasi QRIS secara manual. Nomor transaksi bisa terulang untuk transaksi yang hilang itu; catat di laporan.

## G. Menghentikan server

Di jendela server tekan **`Ctrl+C`** (backup otomatis dibuat), lalu tutup jendela. Data tetap tersimpan di `data\pos.db` dan muncul lagi saat server dijalankan kembali.

## H. Catatan QRIS

Aplikasi ini **tidak** memverifikasi QRIS secara otomatis (tidak mungkin tanpa internet & integrasi PJP). Kasir wajib mengecek notifikasi dana masuk di HP/EDC merchant, baru menekan konfirmasi. Kolom "Ref" boleh diisi 4 digit terakhir / nama pengirim untuk rekonsiliasi.
