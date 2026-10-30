@echo off
rem Klik dua kali untuk menjalankan server kasir di laptop event.
title Kasir Booth Cosplay - Server (JANGAN DITUTUP)
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js belum terpasang. Pasang Node.js 24 LTS dari https://nodejs.org lalu jalankan lagi.
  pause
  exit /b 1
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 (
  echo [!] Versi Node.js terlalu lama. Butuh Node.js 24 atau lebih baru.
  node -v
  pause
  exit /b 1
)

if not exist node_modules (
  echo Menginstal dependensi - butuh internet, cukup sekali sebelum hari event...
  call npm install --omit=dev
  if errorlevel 1 (
    echo [!] Gagal menginstal dependensi. Sambungkan ke internet lalu coba lagi.
    pause
    exit /b 1
  )
)

node server\src\index.ts
echo.
echo Server berhenti.
pause
