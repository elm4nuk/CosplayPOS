// APK upgrade test: data written by an older build must survive installing a
// newer build on top of it (same appId, same signing key, `adb install -r`),
// including the Dexie schema migration running inside a real Android WebView.
//
//   node scripts/device-upgrade-e2e.mjs <old-e2e.apk> <new-e2e.apk>
//
// Both APKs must be E2E builds (`npm run build:e2e`, see docs/DEVICE_TESTING.md
// § 3 for building the old one from a git tag/commit). Like device-e2e.mjs it
// drives `window.__cosplayPosE2E`, not the screens. Writes
// artifacts/device-upgrade/report.json and REPORT.md.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SDK = process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk')
const ADB = join(SDK, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')
const PKG = 'com.cosplaypos.booth'
const PORT = 9334
const OUT = join('artifacts', 'device-upgrade')

const adb = (...args) => execFileSync(ADB, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const shell = (cmd) => { try { return adb('shell', cmd) } catch (e) { return String(e.stdout ?? '') + String(e.stderr ?? '') } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Minimal CDP client on the WebView page (same approach as device-e2e.mjs). */
async function openPage() {
  let target
  for (let i = 0; i < 60 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.url.startsWith('https://localhost')) } catch { /* not up yet */ }
    if (!target) await sleep(500)
  }
  if (!target) throw new Error('Halaman WebView tidak ditemukan (debug build + WebView debugging?).')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('WebSocket CDP gagal')) })
  let seq = 0
  const pending = new Map(), listeners = new Set()
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) }
    else listeners.forEach((l) => l(msg))
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async (fn, arg) => {
    const r = await send('Runtime.evaluate', { expression: `(${fn})(${JSON.stringify(arg ?? null)})`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
  return { send, evaluate, on: (l) => listeners.add(l), close: () => ws.close() }
}

async function launch(external) {
  shell(`am start -W -n ${PKG}/.MainActivity`)
  let pid = ''
  for (let i = 0; i < 40 && !pid; i++) { pid = shell(`pidof ${PKG}`).trim(); if (!pid) await sleep(250) }
  if (!pid) throw new Error('Aplikasi tidak berjalan setelah diluncurkan.')
  try { adb('forward', '--remove', `tcp:${PORT}`) } catch { /* not forwarded yet */ }
  adb('forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`)
  const page = await openPage()
  page.on((m) => { if (m.method === 'Network.requestWillBeSent') { const url = m.params.request.url; if (!/^(https:\/\/localhost\/|data:|blob:)/.test(url)) external.push(url) } })
  await page.send('Network.enable')
  for (let i = 0; i < 60 && !(await page.evaluate(() => Boolean(window.__cosplayPosE2E))); i++) await sleep(500)
  if (!(await page.evaluate(() => Boolean(window.__cosplayPosE2E)))) throw new Error('APK terpasang bukan build uji (window.__cosplayPosE2E tidak ada).')
  return page
}

/** Runs `body` in the page and turns a PosError into `{ error: code, details }`. */
const attempt = (page, body, arg) => page.evaluate(async function ({ body, arg }) {
  const { service } = window.__cosplayPosE2E
  try { return { value: await new Function('service', 'arg', `return (async () => { ${body} })()`)(service, arg) } }
  catch (e) { return { error: e.code ?? String(e), details: e.details ?? null } }
}, { body, arg })

const dump = (page) => attempt(page, `
  await service.ready()
  const out = { verno: service.db.verno }
  for (const t of service.db.tables) out[t.name] = await t.toArray()
  return out`)

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
/** Every field of the old row is unchanged in the new row (new fields may be added). */
const keeps = (oldRow, newRow) => Boolean(newRow) && Object.entries(oldRow).every(([k, v]) => same(v, newRow[k]))

const OLD_FLOW = `
  await service.ready()
  await service.saveSettings({ defaultCashier: 'Rin', shopName: 'Booth Upgrade', receiptPrefix: 'UPG' })
  const cat = await service.saveCategory({ name: 'Print' })
  const p = await service.saveProduct({ name: 'Print Cosmic', categoryId: cat.id, image: arg.photo, variants: [{ name: 'A5', price: 25000, stock: 20 }, { name: 'A4', price: 40000, stock: 10 }] })
  const [a5, a4] = p.variants
  const line = (v, quantity = 1) => ({ productId: p.id, variantId: v.id, quantity })
  const bundle = await service.saveBundle({ name: 'Duo', price: 55000, items: [line(a5), line(a4)] })
  const ev1 = (await service.getBootstrap()).events[0].id
  const t1 = await service.createTransaction({ eventId: ev1, items: [line(a5, 2)], cashReceived: 50000 })
  const t2 = await service.createTransaction({ eventId: ev1, items: [line(a4)], cashReceived: 0, paymentMethod: 'qris' })
  const t3 = await service.createTransaction({ eventId: ev1, items: [line(a5), line(a4)], cashReceived: 60000, discount: 10000, promoName: 'Duo' })
  const ev2 = await service.saveEvent({ name: 'Event yang dihapus build lama' })
  const t4 = await service.createTransaction({ eventId: ev2.id, items: [line(a5)], cashReceived: 25000 })
  await service.deleteEvent(ev2.id)
  const t5 = await service.createTransaction({ eventId: ev1, items: [line(a5)], cashReceived: 25000 })
  await service.voidTransaction(t5.id, 'Uji void sebelum upgrade')
  return { productId: p.id, a5: a5.id, a4: a4.id, bundleId: bundle.id, ev1, t1: t1.id, t2: t2.id, t3: t3.id, deletedTx: t4.id }`

// A5: 20 stok awal, -2 t1, -1 t3, -1 t4 (build lama menghapus t4 bersama eventnya tanpa mengembalikan stok),
// -1 +1 t5 lalu void, -1 bundle setelah upgrade, +2 void t1 setelah upgrade.
const EXPECTED_A5 = 20 - 2 - 1 - 1 - 1 + 1 - 1 + 2

async function main() {
  const [oldApk, newApk] = process.argv.slice(2)
  if (!oldApk || !newApk || !existsSync(oldApk) || !existsSync(newApk)) throw new Error('Pakai: node scripts/device-upgrade-e2e.mjs <old-e2e.apk> <new-e2e.apk>')
  mkdirSync(OUT, { recursive: true })
  adb('get-state')
  const device = { model: shell('getprop ro.product.model'), release: shell('getprop ro.build.version.release'), sdk: shell('getprop ro.build.version.sdk'), emulator: shell('getprop ro.kernel.qemu') === '1' || shell('getprop ro.boot.qemu') === '1' }
  console.log(`Perangkat: ${device.model} Android ${device.release} (API ${device.sdk})${device.emulator ? ' — EMULATOR' : ''}`)
  const external = []

  try { adb('uninstall', PKG) } catch { /* not installed */ }
  adb('install', oldApk)
  let page = await launch(external)
  const photo = `data:image/jpeg;base64,${'Q'.repeat(400)}`
  const seeded = await attempt(page, OLD_FLOW, { photo })
  if (seeded.error) throw new Error(`Alur build lama gagal: ${seeded.error} ${JSON.stringify(seeded.details)}`)
  const ids = seeded.value
  const before = (await dump(page)).value
  const v1Backup = (await attempt(page, 'return JSON.stringify(await service.exportBackup())')).value
  check('build lama menulis data skema lama', before.verno === 1 && before.transactions.length === 4, `verno ${before.verno}, ${before.transactions.length} transaksi, ${before.stockMovements.length} riwayat stok`)
  page.close()

  shell(`am force-stop ${PKG}`)
  const install = adb('install', '-r', newApk)
  check('APK baru terpasang di atas APK lama (tanpa uninstall)', /Success/.test(install), install.split('\n').pop())
  page = await launch(external)
  const after = (await dump(page)).value

  check('database dimigrasi ke skema 2 di WebView', after.verno === 2, `verno ${after.verno}`)
  const txAfter = new Map(after.transactions.map((t) => [t.id, t]))
  check('semua transaksi lama utuh (field lama identik)', before.transactions.length === after.transactions.length && before.transactions.every((t) => keeps(t, txAfter.get(t.id))), `${after.transactions.length} transaksi`)
  check('status bayar: QRIS lama = legacy, tunai = confirmed', txAfter.get(ids.t2)?.paymentStatus === 'legacy' && txAfter.get(ids.t1)?.paymentStatus === 'confirmed' && txAfter.get(ids.t3)?.paymentStatus === 'confirmed')
  const productBefore = before.products.find((p) => p.id === ids.productId)
  const productAfter = after.products.find((p) => p.id === ids.productId)
  check('produk, varian, harga, dan stok identik', same(before.products.map((p) => p.variants), after.products.map((p) => p.variants)), JSON.stringify(productAfter?.variants.map((v) => [v.name, v.price, v.stock])))
  const image = after.images?.find((i) => i.id === productAfter?.imageId)
  check('foto produk pindah ke tabel images tanpa berubah', productAfter && !productAfter.image && image?.dataUrl === productBefore.image)
  const movesAfter = new Map(after.stockMovements.map((m) => [m.id, m]))
  const orphans = after.stockMovements.filter((m) => m.legacyTransactionId)
  check('riwayat stok lengkap; yang yatim ditandai legacyTransactionId', before.stockMovements.length === after.stockMovements.length && orphans.length > 0 && orphans.every((m) => m.legacyTransactionId === ids.deletedTx && !m.transactionId) && before.stockMovements.filter((m) => m.transactionId !== ids.deletedTx).every((m) => same(m, movesAfter.get(m.id))), `${after.stockMovements.length} baris, ${orphans.length} yatim`)
  check('bundle pindah dari meta ke tabel bundles', after.bundles?.some((b) => b.id === ids.bundleId) && !after.meta.some((m) => m.key === 'bundles'))
  check('event lama + archived:false, nomor struk berlanjut', same(after.events.map((e) => e.id), before.events.map((e) => e.id)) && after.events.every((e) => e.archived === false) && same(after.meta.find((m) => m.key === 'txSeq'), before.meta.find((m) => m.key === 'txSeq')))

  const flow = await attempt(page, `
    const line = (v, quantity = 1) => ({ productId: arg.productId, variantId: v, quantity })
    const unconfirmed = await service.createTransaction({ eventId: arg.ev1, items: [line(arg.a4)], cashReceived: 0, paymentMethod: 'qris' }).then(() => 'resolved', (e) => e.code)
    const qris = await service.createTransaction({ eventId: arg.ev1, items: [line(arg.a4)], cashReceived: 0, paymentMethod: 'qris', paymentConfirmed: true, paymentReference: 'ref 4321' })
    const forged = await service.createTransaction({ eventId: arg.ev1, items: [line(arg.a5), line(arg.a4)], cashReceived: 65000, discount: 30000 }).then(() => 'resolved', (e) => e.code + ':' + e.details?.reason)
    const bundle = await service.createTransaction({ eventId: arg.ev1, items: [line(arg.a5), line(arg.a4)], cashReceived: 55000, bundleId: arg.bundleId })
    await service.voidTransaction(arg.t1, 'Uji void setelah upgrade')
    const stock = (await service.getBootstrap()).products[0].variants.map((v) => v.stock)
    const oldReceipt = await service.getReceiptText(arg.t2)
    const newReceipt = await service.getReceiptText(qris.id)
    const backup = await service.exportBackup()
    return { unconfirmed, qris: [qris.number, qris.paymentStatus], forged, bundle: [bundle.total, bundle.discount], stock, oldReceipt, newReceipt, backup: [backup.schemaVersion, backup.counts.images, backup.counts.bundles] }`, ids)
  const f = flow.value ?? {}
  check('setelah upgrade: QRIS tanpa konfirmasi ditolak, dengan konfirmasi tersimpan', flow.value && f.unconfirmed === 'PAYMENT_NOT_CONFIRMED' && f.qris[1] === 'confirmed', flow.error ?? `${f.qris?.[0]}`)
  check('setelah upgrade: diskon palsu ditolak, bundle lama dihitung service', f.forged === 'PROMO_INVALID:UNTRUSTED_DISCOUNT' && same(f.bundle, [55000, 10000]), `${f.forged}, bundle ${JSON.stringify(f.bundle)}`)
  check('setelah upgrade: void transaksi lama mengembalikan stok', f.stock && f.stock[0] === EXPECTED_A5, JSON.stringify(f.stock))
  check('struk QRIS lama jujur, struk baru "dikonfirmasi kasir"', f.oldReceipt?.includes('QRIS (data lama)') && f.newReceipt?.includes('QRIS — dikonfirmasi kasir'))
  check('backup v2 membawa foto dan bundle', same(f.backup, [2, 1, 1]), JSON.stringify(f.backup))

  const restored = await attempt(page, 'return service.restoreBackup(arg)', v1Backup)
  const afterRestore = (await dump(page)).value
  check('restore file backup v1 di aplikasi v2', restored.value?.upgradedFrom === 1 && afterRestore.transactions.length === 4 && afterRestore.images.length === 1 && afterRestore.bundles.length === 1, restored.error ?? `upgradedFrom ${restored.value?.upgradedFrom}, ${afterRestore.transactions.length} transaksi`)
  check('nol request jaringan selama uji', external.length === 0, external.slice(0, 3).join(', '))
  page.close()
  try { adb('forward', '--remove', `tcp:${PORT}`) } catch { /* ignore */ }

  const passed = results.filter((r) => r.ok).length
  const report = { when: new Date().toISOString(), device, oldApk, newApk, passed, total: results.length, results }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(OUT, 'REPORT.md'), [`# Uji upgrade APK — ${passed}/${results.length}`, '', `Perangkat: ${device.model}, Android ${device.release} (API ${device.sdk})${device.emulator ? ' — **EMULATOR, bukan HP fisik**' : ''}`, `Lama: \`${oldApk}\``, `Baru: \`${newApk}\``, '', ...results.map((r) => `- ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`), ''].join('\n'))
  console.log(`\n${passed}/${results.length} lulus → ${join(OUT, 'REPORT.md')}`)
  if (passed !== results.length) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
