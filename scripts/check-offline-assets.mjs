// Fails the build when the bundle would look broken in airplane mode:
// any external stylesheet/font/script/image reference, or a local reference
// (url(), src=, href=, "/path.ext" in JS) whose file is missing from dist/.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'

const dist = resolve(process.argv[2] ?? 'dist')
if (!existsSync(dist)) { console.error(`✗ ${dist} tidak ada. Jalankan npm run build dulu.`); process.exit(1) }

const files = []
const walk = (dir) => readdirSync(dir).forEach((name) => { const p = join(dir, name); statSync(p).isDirectory() ? walk(p) : files.push(p) })
walk(dist)

const problems = []
const external = /(?:src|href)\s*=\s*["'](https?:)?\/\/[^"']+|url\(\s*["']?(https?:)?\/\/[^)"']+|@import\s+["']https?:\/\/[^"']+|fonts\.(?:googleapis|gstatic)\.com/gi
// SVG namespace URIs and similar are identifiers, not network requests.
const harmless = /www\.w3\.org|xmlns|reactjs\.org\/docs|react\.dev\/errors|github\.com\/|capacitorjs\.com/i
const localRef = /url\(\s*["']?([^)"'#?]+\.(?:woff2?|ttf|otf|png|jpe?g|svg|webp|gif))|(?:src|href)\s*=\s*["']([^"'#?]+\.(?:css|js|woff2?|png|jpe?g|svg|webp|ico))["']|["'](\/[\w./-]+\.(?:png|jpe?g|svg|webp|woff2?|json))["']/gi

let fontFiles = 0
for (const file of files) {
  if (/\.(woff2?|ttf|otf)$/.test(file)) fontFiles++
  if (!/\.(html|css|js)$/.test(file)) continue
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(external)) if (!harmless.test(m[0])) problems.push(`${relative(dist, file)}: referensi eksternal ${m[0].slice(0, 90)}`)
  for (const m of text.matchAll(localRef)) {
    const ref = m[1] ?? m[2] ?? m[3]
    if (/^(data:|https?:|\/\/)/.test(ref)) continue
    const target = ref.startsWith('/') ? join(dist, ref) : resolve(dirname(file), ref)
    if (!existsSync(target)) problems.push(`${relative(dist, file)}: file lokal hilang ${ref}`)
  }
}

if (!fontFiles) problems.push('Tidak ada file font di bundle. Font akan jatuh ke font sistem saat offline.')

if (problems.length) {
  console.error(`✗ ${problems.length} masalah aset offline:\n  ${[...new Set(problems)].join('\n  ')}`)
  process.exit(1)
}
console.log(`✓ Aset offline lengkap: ${files.length} file, ${fontFiles} file font, tanpa referensi jaringan.`)
