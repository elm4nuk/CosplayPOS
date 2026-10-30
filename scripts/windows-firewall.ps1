# Izinkan HP/tablet di Wi-Fi lokal mengakses server kasir.
# Jalankan SEKALI di PowerShell "Run as Administrator":
#   powershell -ExecutionPolicy Bypass -File scripts\windows-firewall.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\windows-firewall.ps1 -Port 3000
param([int]$Port = 3000)

$name = "Kasir Booth Cosplay (TCP $Port)"
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Jalankan PowerShell sebagai Administrator (klik kanan > Run as administrator)." -ForegroundColor Red
  exit 1
}

Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
# Profil Private + Public: Wi-Fi router event sering terdeteksi sebagai "Public network".
# Hanya alamat LAN (LocalSubnet) yang diizinkan, bukan internet.
New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port `
  -Profile Private,Public -RemoteAddress LocalSubnet | Out-Null
Write-Host "Aturan firewall '$name' dibuat. HP di Wi-Fi yang sama sekarang bisa membuka http://<ip-laptop>:$Port" -ForegroundColor Green

Write-Host "`nProfil jaringan saat ini:"
Get-NetConnectionProfile | Format-Table Name, InterfaceAlias, NetworkCategory -AutoSize
