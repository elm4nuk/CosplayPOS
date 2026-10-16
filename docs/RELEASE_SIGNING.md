# Rilis bertanda tangan — CosplayPOS

Pemilik file: Claude Code (lihat `docs/HANDOFF.md` § 2 — area `android/**`, `scripts/**`).
Ini melengkapi `docs/HANDOFF.md` § 7 (Aturan rilis) dengan langkah konkretnya.
Toolchain dan lokasi SDK/JDK ada di `docs/ANDROID_SETUP.md`.

Terakhir diperbarui: 2026-10-16 oleh Claude Code.

> **Status jujur:** keystore rilis **belum dibuat** dan APK rilis bertanda tangan **belum pernah
> dibuild**. Dokumen ini adalah prosedurnya, bukan laporan sesuatu yang sudah terjadi. Pembuatan
> keystore butuh password yang hanya boleh diketahui pemilik, jadi § 2 harus dijalankan oleh pemilik
> sendiri, bukan oleh agen. Yang sudah dikerjakan di sesi ini: `android/.gitignore` kini benar-benar
> mengabaikan `*.jks`, `*.keystore`, `*.p12`, dan `keystore.properties` — sebelumnya baris itu masih
> dikomentari oleh template Capacitor, artinya keystore bisa ikut ter-commit tanpa disadari.

## 1. Mengapa ini kritis (baca sebelum apa pun)

Android mengizinkan update sebuah aplikasi **hanya** jika APK baru ditandatangani dengan kunci yang
sama seperti yang sudah terpasang. Kalau kuncinya beda, satu-satunya jalan adalah uninstall — dan
uninstall **menghapus IndexedDB**, yaitu seluruh data kasir: produk, stok, event, transaksi, dan pengaturan booth.

| Kejadian | Akibat |
|---|---|
| Keystore hilang (disk mati, tidak ada cadangan) | Tidak bisa update APK lagi, selamanya. Harus `appId` baru + uninstall + data hilang. |
| Password keystore lupa | Sama seperti hilang. Tidak ada pemulihan. |
| Rilis ditandatangani kunci berbeda dari sebelumnya | Install gagal: `INSTALL_FAILED_UPDATE_INCOMPATIBLE`. |
| Keystore ikut ter-commit ke Git | Siapa pun yang punya salinan repo bisa membuat APK yang menyamar sebagai CosplayPOS. |
| APK **debug** dipakai di HP event | Kunci debug dibuat ulang otomatis per mesin dan hilang kalau `~/.android/debug.keystore` terhapus → suatu hari update ditolak. Jangan pakai APK debug untuk event. |

## 2. Membuat keystore (sekali saja, oleh pemilik)

Jalankan di PowerShell. Simpan filenya **di luar repo** — contoh ini memakai
`%USERPROFILE%\CosplayPOS-keys\`, bukan folder proyek.

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\CosplayPOS-keys" | Out-Null
& "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -v `
  -keystore "$env:USERPROFILE\CosplayPOS-keys\cosplaypos-release.jks" `
  -alias cosplaypos `
  -keyalg RSA -keysize 4096 `
  -validity 10950 `
  -storetype PKCS12
```

- `-validity 10950` = 30 tahun. Kunci kedaluwarsa tidak bisa menandatangani update.
- `-storetype PKCS12` = format standar sekarang; JKS sudah dianggap usang oleh JDK.
- `keytool` menanyakan password store lalu data pemilik (CN, O, L, C). Isi apa adanya; data ini tidak
  ditampilkan ke pengguna aplikasi.
- Catat password di pengelola password, **bukan** di file teks pada PC yang sama.

Verifikasi dan catat fingerprint-nya:

```powershell
& "$env:JAVA_HOME\bin\keytool.exe" -list -v -keystore "$env:USERPROFILE\CosplayPOS-keys\cosplaypos-release.jks"
```

Simpan **SHA-256 fingerprint** dari output itu di pengelola password. Itu alat untuk memastikan
rilis berikutnya benar-benar memakai kunci yang sama (§ 5).

### Cadangan keystore (wajib, bukan opsional)

Minimal dua salinan di media berbeda dari PC pengembang, misal flashdisk terenkripsi + penyimpanan
cloud pribadi. Password disimpan terpisah dari filenya. Tanpa cadangan, satu disk mati = aplikasi
tidak bisa di-update selamanya.

## 3. Menghubungkan keystore ke build (belum diterapkan — lihat § 7)

`android/app/build.gradle` akan membaca kredensial dari `android/keystore.properties` yang tidak ikut
Git (sudah diabaikan sejak sesi ini). Isi file itu:

```properties
storeFile=D:\\keys-outside-repo\\cosplaypos-release.jks
storePassword=...
keyAlias=cosplaypos
keyPassword=...
```

Blok Gradle yang akan ditambahkan. Perhatikan penjagaannya: kalau `keystore.properties` tidak ada,
`assembleDebug` dan `npm run android:e2e` tetap berjalan persis seperti sekarang, dan hanya
`assembleRelease` yang menghasilkan APK tak bertanda tangan.

```gradle
def keystorePropsFile = rootProject.file("keystore.properties")
def keystoreProps = new Properties()
if (keystorePropsFile.exists()) {
    keystorePropsFile.withInputStream { keystoreProps.load(it) }
}

android {
    signingConfigs {
        release {
            if (keystorePropsFile.exists()) {
                storeFile file(keystoreProps.getProperty('storeFile'))
                storePassword keystoreProps.getProperty('storePassword')
                keyAlias keystoreProps.getProperty('keyAlias')
                keyPassword keystoreProps.getProperty('keyPassword')
            }
        }
    }
    buildTypes {
        release {
            if (keystorePropsFile.exists()) {
                signingConfig signingConfigs.release
            }
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
        }
    }
}
```

Alternatif tanpa menyentuh `build.gradle`: tanda tangani manual dengan `apksigner` atas
`app-release-unsigned.apk`. Lebih rawan lupa langkah, jadi jalur Gradle di atas yang dipilih.

## 4. Urutan setiap rilis

1. **Ekspor backup dari HP lebih dulu** (HANDOFF § 7 aturan 4). Tanpa ini, kesalahan apa pun di
   langkah berikutnya berarti data event hilang.
2. Naikkan `versionCode` di `android/app/build.gradle` (integer, selalu naik; Android menolak turun)
   dan `versionName` bila perlu. Sekarang `versionCode 1`, `versionName "1.0"`.
3. Pastikan `appId`, `server.androidScheme`, dan `server.hostname` di `capacitor.config.ts` **tidak
   berubah** (HANDOFF § 7 aturan 1 — IndexedDB terikat origin; berubah = data tak terbaca).
4. `npm test` dan `npx tsc -b && npm run lint` hijau.
5. `npm run android:sync` (sudah termasuk `npm run check:offline`).
6. Build rilis: `node scripts/gradle-assemble.mjs assembleRelease`. Di PC ini `cd android && gradlew`
   gagal (`NoDefaultCurrentDirectoryInExePath`) — lihat HANDOFF § Log.
7. Verifikasi tanda tangan (§ 5). **Jangan dilewati.**
8. Pasang di atas versi lama tanpa uninstall: `adb install -r <apk>`, lalu cek data masih utuh
   (jumlah produk, stok, transaksi). Ini uji nomor 4 di HANDOFF § 8.

## 5. Verifikasi sebelum dipasang di HP event

```powershell
$bt = "$env:ANDROID_HOME\build-tools\36.0.0"
$apk = "android\app\build\outputs\apk\release\app-release.apk"

& "$bt\apksigner.bat" verify --print-certs --verbose $apk
& "$bt\aapt2.exe" dump badging $apk | Select-String "package:|application-label:"
```

Yang harus benar:

- `apksigner` mencetak `Verifies`, dan SHA-256 certificate digest-nya **sama** dengan yang dicatat di
  § 2. Beda = kunci salah, jangan dipasang.
- `package: name='com.cosplaypos.booth'` dengan `versionCode` lebih besar dari yang terpasang di HP.
- `application-label:'CosplayPOS'`.

## 6. Pertanyaan terbuka yang memengaruhi rilis: `allowBackup`

`android:allowBackup="true"` di `android/app/src/main/AndroidManifest.xml` masih nilai bawaan
template Capacitor. Ini pertanyaan terbuka untuk pemilik (HANDOFF § 9).

| Pilihan | Untung | Rugi |
|---|---|---|
| `true` (sekarang) | Google bisa memulihkan data aplikasi otomatis saat install ulang / ganti HP. | Pemulihan terjadi **tanpa disadari** dan bisa menghidupkan DB lama — stok dan nomor struk jadi tidak konsisten dengan kenyataan. Data kasir juga terkirim ke akun Google, padahal keputusan proyek adalah 100% offline. |
| `false` | Perilaku dapat diprediksi: satu-satunya jalur pemulihan adalah ekspor/restore manual yang sudah punya test dan checksum. Tidak ada data kasir yang keluar dari HP. | Pemilik yang lupa ekspor lalu HP-nya hilang tidak punya jalan pulih. |

**Rekomendasi: `false`.** Alasan utamanya bukan privasi, tapi integritas: jalur restore manual sudah
divalidasi (checksum, tolak skema lebih baru, snapshot `previous`), sedangkan Android Auto Backup
tidak lewat validasi itu sama sekali dan bisa menyuntikkan DB lama ke instalasi baru. Dua jalur
pemulihan yang tidak saling tahu adalah sumber bug stok yang sangat sulit dilacak di tengah event.

Kalau `false` disetujui, konsekuensinya: UI **wajib** mengingatkan ekspor backup di akhir hari event
(sudah ada di antrian permintaan ke Codex, HANDOFF § 9 #5). Perubahan ini belum diterapkan karena ia
mengubah perilaku produk — menunggu keputusan pemilik.

## 7. Yang belum dikerjakan

- Blok `signingConfigs` di § 3 **belum** ditulis ke `android/app/build.gradle`. Ditahan karena sesi
  Claude lain sedang menjalankan `npm run android:e2e` (`assembleDebug`) di working tree yang sama;
  mengubah skrip build saat Gradle mengevaluasinya bisa menggagalkan build itu dan menghasilkan
  laporan uji yang salah. Terapkan setelah sesi itu selesai.
- Keystore belum dibuat (§ 2 — butuh password pemilik).
- `assembleRelease` belum pernah dijalankan, jadi klaim "APK rilis sukses" belum boleh dibuat.
- `allowBackup` belum diubah (§ 6 — menunggu keputusan pemilik).
- `.gitignore` di root repo belum memuat pola keystore. `android/.gitignore` hanya berlaku untuk
  subfolder `android/`, jadi keystore yang tersimpan di root repo masih bisa ter-commit. File itu
  dipakai bersama dengan sesi/Codex, jadi tidak saya ubah sendiri — lihat permintaan di HANDOFF.
