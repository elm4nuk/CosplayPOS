# Setup build Android — CosplayPOS

Pemilik file: Claude Code (lihat `docs/HANDOFF.md` § 2). Catatan faktual tentang toolchain di PC ini
dan cara memasangnya ulang dari sumber resmi. Aturan rilis (keystore, `appId`, `versionCode`) tetap di
`docs/HANDOFF.md` § 7 — baca itu dulu sebelum rilis pertama.

Terakhir diverifikasi: 2026-10-16, Windows 11 Home Single Language 10.0.26200 (x86_64).

## 1. Yang terpasang di PC ini

| Komponen | Versi | Lokasi |
|---|---|---|
| JDK (Eclipse Temurin 21, LTS) | `21.0.12.1+1` | `C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot` |
| Android SDK (root) | — | `%LOCALAPPDATA%\Android\Sdk` |
| Command-line Tools | `23.0` | `…\Sdk\cmdline-tools\latest` |
| Platform-Tools (`adb`) | `37.0.1` (adb 1.0.41) | `…\Sdk\platform-tools` |
| Platform Android 36 (Android 16) | rev 2 | `…\Sdk\platforms\android-36` |
| Build-Tools | `36.0.0` (dan `35.0.0`) | `…\Sdk\build-tools` |
| Emulator | `37.2.12` | `…\Sdk\emulator` |
| System image | `system-images;android-36.1;google_apis;x86_64` rev 4 | `…\Sdk\system-images` |
| AVD uji | `cosplaypos_api36` (Pixel 6, Android 16) | `%USERPROFILE%\.android\avd` |
| Gradle (wrapper, otomatis diunduh) | `8.14.3` | `android/gradle/wrapper/gradle-wrapper.properties` |
| Android Gradle Plugin | `8.13.0` | `android/build.gradle` |

Konfigurasi proyek: `minSdkVersion 24`, `compileSdkVersion 36`, `targetSdkVersion 36`
(`android/variables.gradle`); `appId` `com.cosplaypos.booth`, label `CosplayPOS`.

Variabel lingkungan (scope **User**, sudah diset):

```
JAVA_HOME   = C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot
ANDROID_HOME= %LOCALAPPDATA%\Android\Sdk
PATH       += %ANDROID_HOME%\platform-tools;%ANDROID_HOME%\cmdline-tools\latest\bin
```

`ANDROID_SDK_ROOT` sengaja dibiarkan kosong (sudah usang; Gradle/AGP memakai `ANDROID_HOME` dan
`android/local.properties` → `sdk.dir`). `java` tidak dimasukkan ke `PATH`; Gradle memakai `JAVA_HOME`.
`android/local.properties` berisi `sdk.dir` dan **tidak** boleh di-commit (sudah di `.gitignore`
bawaan template Capacitor).

## 2. Memasang ulang dari nol (sumber resmi, tanpa Android Studio)

Android Studio tidak dibutuhkan untuk `assembleDebug`; yang wajib hanya JDK 21 + command-line tools.

1. **JDK 21** — unduh installer MSI x64 Temurin 21 (LTS) dari <https://adoptium.net/temurin/releases/>
   (`jdk-21…-hotspot`), pasang dengan opsi *Set JAVA_HOME variable*. Verifikasi:
   `java -version` → `openjdk version "21.…"`.
2. **Command-line tools** — unduh *Command line tools only* (Windows) dari
   <https://developer.android.com/studio#command-line-tools-only>, ekstrak sehingga isinya berada di
   `%LOCALAPPDATA%\Android\Sdk\cmdline-tools\latest\` (folder `latest` wajib — di dalam zip namanya
   `cmdline-tools`, ganti namanya).
3. **Variabel lingkungan** (PowerShell, scope User, lalu buka terminal baru):
   ```powershell
   [Environment]::SetEnvironmentVariable('ANDROID_HOME', "$env:LOCALAPPDATA\Android\Sdk", 'User')
   [Environment]::SetEnvironmentVariable('PATH', [Environment]::GetEnvironmentVariable('PATH','User') +
     ";$env:LOCALAPPDATA\Android\Sdk\platform-tools;$env:LOCALAPPDATA\Android\Sdk\cmdline-tools\latest\bin", 'User')
   ```
4. **Paket SDK + lisensi**:
   ```powershell
   sdkmanager --licenses                 # jawab y untuk semua
   sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
   # opsional, hanya untuk uji tanpa HP:
   sdkmanager "emulator" "system-images;android-36.1;google_apis;x86_64"
   avdmanager create avd -n cosplaypos_api36 -k "system-images;android-36.1;google_apis;x86_64" -d pixel_6
   ```
   `sdkmanager --list_installed` memverifikasi hasilnya. Perintah `sdkmanager` bisa lama (menit
   pertama mengunduh indeks repositori) — itu normal, bukan hang.

## 3. Build

```bash
npm ci
npm run android:sync     # vite build + cek aset offline + cap sync android
npm run android:apk      # + gradlew assembleDebug
```

Hasil: `android/app/build/outputs/apk/debug/app-debug.apk` (± 10 MB, ditandatangani debug key).
`npm run android:apk` di Windows memanggil `gradlew`; di macOS/Linux ganti ke `./gradlew`.

Build pertama mengunduh Gradle 8.14.3 + dependensi AndroidX (butuh internet, ± 5–10 menit).
Build berikutnya offline dari cache Gradle (`%USERPROFILE%\.gradle`).

Memeriksa APK tanpa memasangnya:

```powershell
& "$env:ANDROID_HOME\build-tools\36.0.0\aapt2.exe" dump badging android\app\build\outputs\apk\debug\app-debug.apk
```

## 4. Memasang ke perangkat / emulator

```powershell
adb devices -l                                   # HP fisik: aktifkan USB debugging dulu
adb install -r android\app\build\outputs\apk\debug\app-debug.apk
adb shell am start -n com.cosplaypos.booth/.MainActivity
adb exec-out screencap -p > artifacts\apk-smoke.png
adb logcat -d -s Capacitor:* chromium:* AndroidRuntime:*   # error WebView/JS
```

Emulator headless (tanpa jendela, untuk pemeriksaan otomatis):

```powershell
emulator -avd cosplaypos_api36 -no-window -no-boot-anim -no-snapshot-save -gpu swiftshader_indirect -port 5556
adb -s emulator-5556 wait-for-device shell 'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 1; done'
```

Emulator **bukan pengganti uji di HP event**: ia tidak membuktikan performa perangkat asli, perilaku
WebView vendor (Xiaomi/Samsung), penyimpanan yang dibersihkan sistem, atau printer Bluetooth.
Checklist uji manual wajib ada di `docs/HANDOFF.md` § 8.
