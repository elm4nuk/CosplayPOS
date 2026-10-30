import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

function findKeytool() {
  const javaHome = process.env.JAVA_HOME
  if (javaHome) {
    const kt = join(javaHome, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool')
    if (existsSync(kt)) return kt
  }
  return process.platform === 'win32' ? 'keytool.exe' : 'keytool'
}

const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = (q, def = '') => new Promise((res) => {
  rl.question(def ? `${q} [${def}]: ` : `${q}: `, (ans) => res(ans.trim() || def))
})

async function main() {
  console.log('\n=== PEMBUATAN KEYSTORE RILIS ANDROID - COSPLAYPOS ===\n')
  console.log('Keystore rilis adalah kunci kriptografi permanen untuk menandatangani APK/AAB.')
  console.log('Android menolak update jika keystore berbeda dari rilis sebelumnya.\n')

  const defaultDir = join(process.env.USERPROFILE || process.env.HOME || '.', 'CosplayPOS-keys')
  const keyDir = await ask('Folder penyimpanan keystore (di luar repo)', defaultDir)
  const keyPath = resolve(join(keyDir, 'cosplaypos-release.jks'))
  const alias = await ask('Key Alias', 'cosplaypos')

  if (existsSync(keyPath)) {
    console.error(`\n[PERINGATAN] File keystore sudah ada di ${keyPath}!`)
    const overwrite = await ask('Apakah ingin menimpa file ini? (y/n)', 'n')
    if (overwrite.toLowerCase() !== 'y') {
      console.log('Dibatalkan demi keamanan data.')
      rl.close()
      process.exit(0)
    }
  }

  const pass = await ask('Password Keystore (minimal 6 karakter)')
  if (!pass || pass.length < 6) {
    console.error('Password terlalu pendek atau kosong. Dibatalkan.')
    rl.close()
    process.exit(1)
  }

  const dname = 'CN=CosplayPOS Owner, OU=Booth, O=CosplayPOS, L=Jakarta, ST=DKI Jakarta, C=ID'

  mkdirSync(keyDir, { recursive: true })

  const keytool = findKeytool()
  console.log(`\nMenjalankan keytool: ${keytool}...`)

  const args = [
    '-genkeypair', '-v',
    '-keystore', keyPath,
    '-alias', alias,
    '-keyalg', 'RSA',
    '-keysize', '4096',
    '-validity', '10950',
    '-storetype', 'PKCS12',
    '-storepass', pass,
    '-keypass', pass,
    '-dname', dname,
  ]

  const res = spawnSync(keytool, args, { stdio: 'inherit' })
  if (res.status !== 0) {
    console.error('\nGagal membuat keystore via keytool.')
    rl.close()
    process.exit(1)
  }

  // Tulis keystore.properties di android/
  const propContent = [
    '# Otomatis dibuat oleh scripts/create-release-keystore.mjs',
    `storeFile=${keyPath.replace(/\\/g, '\\\\')}`,
    `storePassword=${pass}`,
    `keyAlias=${alias}`,
    `keyPassword=${pass}`,
    '',
  ].join('\n')

  const propPath = resolve('android/keystore.properties')
  writeFileSync(propPath, propContent, 'utf8')

  console.log('\n[SUKSES] Keystore berhasil dibuat!')
  console.log(`Lokasi Keystore: ${keyPath}`)
  console.log(`Konfigurasi tersimpan: ${propPath} (otomatis diabaikan git)`)
  console.log('\n[PENTING] Salin file .jks ini ke flashdisk atau cloud storage aman!')
  console.log('Sekarang Anda bisa menjalankan `npm run android:release` atau `npm run android:bundle`.\n')

  // Print fingerprint
  console.log('--- SHA-256 Certificate Fingerprint ---')
  spawnSync(keytool, ['-list', '-v', '-keystore', keyPath, '-storepass', pass], { stdio: 'inherit' })

  rl.close()
}

main().catch((err) => {
  console.error(err)
  rl.close()
  process.exit(1)
})
