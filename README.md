# Kasir Booth Cosplay

Sistem kasir offline-first untuk booth di event seperti Comifuro. Satu laptop menjadi server lokal (Node.js + SQLite); HP/tablet kasir membuka website lewat Wi-Fi yang sama. Internet tidak dibutuhkan saat berjualan.

- **Backend** (`server/`): Node.js 24 + TypeScript (dijalankan langsung, tanpa build), Fastify, SQLite bawaan Node (`node:sqlite`, tanpa modul native).
- **Frontend** (`web/`): dikerjakan terpisah; hasil build `web/dist` disajikan oleh server yang sama.

## Mulai cepat

```powershell
npm install
npm run seed:demo   # admin/admin123, kasir1/kasir123, kasir2/kasir123 + event & produk demo
npm start           # http://localhost:3000 dan http://<ip-laptop>:3000 dari HP
```

Di Windows cukup klik dua kali `start-server.bat`.

## Dokumentasi

- [docs/API_CONTRACT.md](docs/API_CONTRACT.md) — model data, endpoint, format error, autentikasi, alur checkout.
- [docs/INTEGRATION_NOTES.md](docs/INTEGRATION_NOTES.md) — untuk developer frontend: cara menjalankan, akun demo, aturan integrasi, yang belum selesai.
- [docs/OPERATIONS_WINDOWS.md](docs/OPERATIONS_WINDOWS.md) — setup laptop Windows, akses dari HP di LAN, firewall, backup & pemulihan.

## Skrip

| Perintah | Fungsi |
|---|---|
| `npm start` / `npm run dev` | Jalankan server (dev: auto-restart) |
| `npm run seed:demo` | Data demo (aman diulang) |
| `npm run backup [-- <folder>]` | Backup manual (aman saat server jalan) |
| `npm run restore -- <file>` | Pulihkan database (server harus mati) |
| `npm run smoke:lan -- <url>` | Uji 2 kasir berebut stok terakhir pada server yang berjalan |
| `npm test` / `npm run typecheck` | Tes otomatis / pemeriksaan tipe |

## Lisensi & referensi

Arsitektur LAN/POS terinspirasi konsep umum proyek POS offline seperti [nodedr-pos](https://github.com/Raktim94/nodedr-pos) (AGPL-3.0). **Tidak ada kode yang disalin** dari proyek tersebut.
