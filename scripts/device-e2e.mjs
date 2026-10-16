// Device test for the storage/security layer on a real Android WebView
// (physical phone or emulator) via adb + Chrome DevTools Protocol.
//
//   npm run android:e2e            # builds the E2E APK, installs, runs, writes a report
//   node scripts/device-e2e.mjs    # reuse the APK already built
//
// It drives `window.__cosplayPosE2E` (present only in the VITE_E2E build), NOT the
// screens: UI flows (quick cash buttons, file picker, PIN dialogs) are Codex's and
// need a separate UI pass. Everything runs with the radios off: airplane mode
// plus an explicit Wi-Fi/data shutdown, restored at the end (see goOffline()).
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SDK = process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk')
const ADB = join(SDK, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')
const PKG = 'com.cosplaypos.booth'
const APK = 'android/app/build/outputs/apk/debug/app-debug.apk'
const PORT = 9333
const OUT = join('artifacts', 'device-e2e')

const adb = (...args) => execFileSync(ADB, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const shell = (cmd) => { try { return adb('shell', cmd) } catch (e) { return String(e.stdout ?? '') + String(e.stderr ?? '') } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const check = (gate, name, ok, detail = '') => {
  results.push({ gate, name, ok: Boolean(ok), detail })
  console.log(`${ok ? '✓' : '✗'} [${gate}] ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Network state captured by goOffline(), so even a crash can put the device back. */
let networkBefore = null

/**
 * Airplane mode is not enough: on the emulator `cmd connectivity airplane-mode
 * enable` leaves Wi-Fi associated and ICMP flowing, so the "offline" gates would
 * run with a live network. Turn each radio off explicitly and prove it with
 * dumpsys (no active default network) plus a ping that must fail.
 */
async function goOffline() {
  networkBefore = {
    airplane: shell('settings get global airplane_mode_on').trim(),
    wifi: shell('settings get global wifi_on').trim(),
    data: shell('settings get global mobile_data').trim(),
  }
  shell('cmd connectivity airplane-mode enable')
  shell('svc wifi disable')
  shell('svc data disable')
  let net = '', ping = ''
  // Radios take a few seconds to drop; never launch the app while a network is still up.
  for (let i = 0; i < 40; i++) {
    net = (shell('dumpsys connectivity').match(/Active default network: (\S+)/) ?? [])[1] ?? ''
    ping = shell('ping -c 1 -W 2 8.8.8.8 >/dev/null 2>&1; echo $?').trim()
    if (net === 'none' && ping !== '0') break
    await sleep(500)
  }
  return {
    airplane: shell('settings get global airplane_mode_on').trim() === '1',
    wifiOff: shell('settings get global wifi_on').trim() !== '1',
    network: net,
    pingExit: ping,
    before: networkBefore,
  }
}

/** Puts the radios back exactly as they were before goOffline(). */
function restoreNetwork() {
  if (!networkBefore) return null
  const before = networkBefore
  networkBefore = null
  shell('cmd connectivity airplane-mode disable')
  if (before.wifi === '1') shell('svc wifi enable')
  if (before.data === '1') shell('svc data enable')
  if (before.airplane === '1') shell('cmd connectivity airplane-mode enable')
  return {
    airplane: shell('settings get global airplane_mode_on').trim(),
    wifi: shell('settings get global wifi_on').trim(),
    data: shell('settings get global mobile_data').trim(),
    wanted: before,
  }
}

/**
 * Minimal CDP client on the page target. Playwright's connectOverCDP needs browser
 * context management, which Android WebView does not support.
 */
async function openPage() {
  let target
  for (let i = 0; i < 40 && !target; i++) {
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
  const nextEvent = (method, timeout = 20_000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(l); reject(new Error(`timeout ${method}`)) }, timeout)
    const l = (m) => { if (m.method === method) { clearTimeout(timer); listeners.delete(l); resolve(m.params) } }
    listeners.add(l)
  })
  return { send, evaluate, nextEvent, on: (l) => listeners.add(l), close: () => ws.close() }
}

async function launchAndConnect(external) {
  shell(`am start -W -n ${PKG}/.MainActivity`)
  let pid = ''
  for (let i = 0; i < 40 && !pid; i++) { pid = shell(`pidof ${PKG}`).trim(); if (!pid) await sleep(250) }
  if (!pid) throw new Error('Aplikasi tidak berjalan setelah diluncurkan.')
  try { adb('forward', '--remove', `tcp:${PORT}`) } catch { /* not forwarded yet */ }
  adb('forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`)
  const page = await openPage()
  page.on((m) => { if (m.method === 'Network.requestWillBeSent') { const url = m.params.request.url; if (!/^(https:\/\/localhost\/|data:|blob:)/.test(url)) external.push(url) } })
  await page.send('Network.enable')
  await page.send('Page.enable')
  // Reload once while listening so the full startup (HTML, JS, CSS, fonts) is observed.
  const loaded = page.nextEvent('Page.loadEventFired')
  await page.send('Page.reload', { ignoreCache: true })
  await loaded
  for (let i = 0; i < 40 && !(await page.evaluate(() => Boolean(window.__cosplayPosE2E))); i++) await sleep(500)
  if (!(await page.evaluate(() => Boolean(window.__cosplayPosE2E)))) throw new Error('APK terpasang bukan build uji (window.__cosplayPosE2E tidak ada). Jalankan npm run android:e2e.')
  return { browser: page, page }
}

/** Runs `body` in the page and turns a PosError into `{ error: code, details }`. */
const attempt = (page, body, arg) => page.evaluate(async function ({ body, arg }) {
  const { service, files } = window.__cosplayPosE2E
  try { return { value: await new Function('service', 'files', 'arg', `return (async () => { ${body} })()`)(service, files, arg) } }
  catch (e) { return { error: e.code ?? String(e), details: e.details ?? null } }
}, { body, arg })

const snapshot = (page) => attempt(page, `
  const d = await service.getBootstrap()
  return {
    products: d.products.map((p) => ({ id: p.id, name: p.name, stock: p.variants.map((v) => v.stock) })),
    events: d.events.map((e) => ({ id: e.id, name: e.name, active: e.active })),
    transactions: d.transactions.map((t) => ({ number: t.number, eventId: t.eventId, total: t.total, cash: t.cashReceived, change: t.change, status: t.status })),
  }`)

/** --build: put dist-e2e/ into the Android assets and assemble, without touching dist/. */
function buildApk() {
  const assets = join('android', 'app', 'src', 'main', 'assets', 'public')
  if (!existsSync(join('dist-e2e', 'index.html'))) throw new Error('dist-e2e/ belum ada. Jalankan npm run build:e2e.')
  rmSync(assets, { recursive: true, force: true })
  cpSync('dist-e2e', assets, { recursive: true })
  const bundled = readdirSync(join(assets, 'assets')).some((f) => f.endsWith('.js') && readFileSync(join(assets, 'assets', f), 'utf8').includes('__cosplayPosE2E'))
  if (!bundled) throw new Error('Aset Android tidak memuat hook E2E.')
  execFileSync(process.execPath, [join('scripts', 'gradle-assemble.mjs'), 'assembleDebug'], { stdio: 'inherit' })
  console.log('⚠ APK ini build UJI. Jalankan npm run android:apk sebelum membagikan APK.')
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  if (process.argv.includes('--build')) buildApk()
  const state = adb('get-state')
  const model = shell('getprop ro.product.model'), release = shell('getprop ro.build.version.release'), sdk = shell('getprop ro.build.version.sdk')
  const emulator = shell('getprop ro.kernel.qemu') === '1' || shell('getprop ro.boot.qemu') === '1'
  const device = { state, model, android: release, sdk, emulator }
  console.log(`Perangkat: ${model} · Android ${release} (API ${sdk})${emulator ? ' · EMULATOR' : ''}`)

  const external = []

  // Gate 1: fresh install, airplane mode on, onboarding offline.
  try { adb('uninstall', PKG) } catch { /* not installed */ }
  adb('install', '-r', APK)
  const offline = await goOffline()
  const isOffline = offline.airplane && offline.wifiOff && offline.network === 'none' && offline.pingExit !== '0'
  const offlineDetail = `airplane_mode_on=${offline.airplane ? 1 : 0}, wifi off=${offline.wifiOff}, active network=${offline.network}, ping 8.8.8.8 exit=${offline.pingExit}`
  if (!isOffline) throw new Error(`Jaringan tidak mati (${offlineDetail}); uji offline dibatalkan.`)
  check(1, 'Mode pesawat + Wi-Fi/data mati: tidak ada jaringan aktif dan ping gagal', isOffline, offlineDetail)

  let { browser, page } = await launchAndConnect(external)
  // Browsers only fetch faces a screen uses, so request every bundled face explicitly.
  const FACES = ['600 16px Fredoka', '700 16px Fredoka', '400 16px Nunito', '600 16px Nunito', '700 16px Nunito', '700 16px "Pixelify Sans"']
  const fonts = await page.evaluate(async (faces) => Promise.all(faces.map(async (face) => ({ face, ok: (await document.fonts.load(face, 'Rp 15.000 Kembalian')).some((f) => f.status === 'loaded') }))), FACES)
  check(8, 'Semua font bundel bisa dimuat tanpa internet', fonts.every((f) => f.ok), fonts.map((f) => `${f.face.replace(/^\d+ 16px /, '').replace(/"/g, '')} ${f.face.slice(0, 3)}${f.ok ? '' : ' GAGAL'}`).join(', '))
  const ready = await attempt(page, 'return service.ready()')
  // `firstRun` is only true for the very first ready() call; the UI already made it before the reload.
  check(1, 'Instalasi baru langsung siap tanpa login atau PIN', ready.value && !ready.error, JSON.stringify(ready.value))
  const persisted = await page.evaluate(() => navigator.storage?.persisted?.() ?? null)
  const setup = await attempt(page, 'return service.saveSettings(arg)', { defaultCashier: 'Kasir Uji', shopName: 'Booth Bintang' })
  check(1, 'Pengaturan awal tersimpan offline tanpa autentikasi', setup.value?.defaultCashier === 'Kasir Uji', `storage.persisted=${persisted}`)

  // Gate 2: product with stock 1, sell 1, next sale rejected. Gate 4: numbers.
  const seed = await attempt(page, `
    const c = await service.saveCategory({ name: 'Charm' })
    const p = await service.saveProduct({ name: 'Acrylic Uji', categoryId: c.id, variants: [{ name: 'Satu', price: 35000, stock: 1 }] })
    const q = await service.saveProduct({ name: 'Print Uji', categoryId: c.id, variants: [{ name: 'A5', price: 20000, stock: 5 }] })
    const d = await service.getBootstrap()
    return { p, q, eventId: d.events.find((e) => e.active).id }`)
  const { p, q, eventId } = seed.value
  const line = { productId: p.id, variantId: p.variants[0].id, quantity: 1 }
  const sale = await attempt(page, 'return service.createTransaction(arg)', { eventId, items: [line], cashReceived: 50000, idempotencyKey: crypto.randomUUID() })
  check(4, 'Total, uang diterima, kembalian dari angka transaksi', sale.value?.total === 35000 && sale.value.cashReceived === 50000 && sale.value.change === 15000, `${sale.value?.number}: total ${sale.value?.total}, tunai ${sale.value?.cashReceived}, kembali ${sale.value?.change}`)
  const again = await attempt(page, 'return service.createTransaction(arg)', { eventId, items: [line], cashReceived: 35000 })
  check(2, 'Stok 1 terjual, penjualan berikutnya ditolak', again.error === 'STOCK_CHANGED', JSON.stringify(again.details))
  const short = await attempt(page, 'return service.createTransaction(arg)', { eventId, items: [{ productId: q.id, variantId: q.variants[0].id, quantity: 1 }], cashReceived: 19999 })
  check(4, 'Uang kurang ditolak', short.error === 'INSUFFICIENT_CASH')

  // Gate 5 (revised MVP): destructive action needs a reason, never authentication.
  const voidWithoutReason = await attempt(page, 'return service.voidTransaction(arg, "")', sale.value.id)
  const exported = await attempt(page, 'return JSON.stringify(await service.exportBackup())')
  check(5, 'Void tanpa alasan ditolak', voidWithoutReason.error === 'VALIDATION')
  const voided = await attempt(page, 'return service.voidTransaction(arg, "Salah pilih varian")', sale.value.id)
  check(5, 'Void beralasan tersimpan dan stok kembali tanpa PIN', voided.value?.status === 'void' && voided.value?.voidReason === 'Salah pilih varian' && voided.value.items[0].stock === 1)
  check(5, 'Backup tidak membawa metadata PIN lama', !exported.value.includes('pin:') && !exported.value.includes('pinGuard:'))

  // Gate 6: two events, separate reports.
  const sale1 = await attempt(page, 'return service.createTransaction(arg)', { eventId, items: [{ productId: q.id, variantId: q.variants[0].id, quantity: 2 }], cashReceived: 50000 })
  const ev2 = await attempt(page, 'const e = await service.saveEvent({ name: "Event Uji 2", venue: "Bandung" }); await service.setActiveEvent(e.id); return e')
  await attempt(page, 'return service.createTransaction(arg)', { eventId: ev2.value.id, items: [line], cashReceived: 35000 })
  await attempt(page, 'return service.createTransaction(arg)', { eventId: ev2.value.id, items: [{ productId: q.id, variantId: q.variants[0].id, quantity: 1 }], cashReceived: 20000 })
  const r1 = (await attempt(page, 'return service.getEventReport(arg)', eventId)).value
  const r2 = (await attempt(page, 'return service.getEventReport(arg)', ev2.value.id)).value
  check(6, 'Laporan event 1 terpisah', r1.revenue === 40000 && r1.transactionCount === 1 && r1.voidCount === 1, `omzet ${r1.revenue}, trx ${r1.transactionCount}, void ${r1.voidCount}`)
  check(6, 'Laporan event 2 terpisah', r2.revenue === 55000 && r2.transactionCount === 2, `omzet ${r2.revenue}, trx ${r2.transactionCount}`)
  check(6, 'Transaksi event 1 tetap', sale1.value?.total === 40000)

  // Gate 7 (part 1): export outside the app's internal storage.
  const before = (await snapshot(page)).value
  const backupName = `e2e-${Date.now()}.json`
  const saved = await attempt(page, 'return files.saveToDevice(arg.name, JSON.stringify(await service.exportBackup()))', { name: backupName })
  const listed = shell(`ls -l /sdcard/Documents/CosplayPOS/${backupName}`)
  check(7, 'Backup tersimpan di Dokumen/CosplayPOS (di luar storage internal aplikasi)', saved.value?.saved && !/No such file/.test(listed), `${saved.value?.location ?? saved.error} · ${listed.split(/\s+/).slice(4, 5).join('')} byte`)
  const localBackup = join(OUT, backupName)
  adb('pull', `/sdcard/Documents/CosplayPOS/${backupName}`, localBackup)
  await browser.close()

  // Gate 3: force stop + relaunch keeps everything.
  shell(`am force-stop ${PKG}`)
  ;({ browser, page } = await launchAndConnect(external))
  const reopened = await attempt(page, 'const t = performance.now(); const r = await service.ready(); return { ...r, readyMs: Math.round(performance.now() - t) }')
  check(3, 'Aplikasi dibuka ulang langsung siap', !reopened.error, `${reopened.value?.readyMs} ms`)
  const afterRestart = (await snapshot(page)).value
  check(3, 'Setelah tutup paksa: transaksi, stok, event utuh', JSON.stringify(afterRestart) === JSON.stringify(before), `${afterRestart.transactions.length} trx, ${afterRestart.events.length} event`)
  await browser.close()

  // Gate 7 (part 2): uninstall, install again (test install), restore from the exported file.
  adb('uninstall', PKG)
  adb('install', APK)
  ;({ browser, page } = await launchAndConnect(external))
  const freshReady = (await attempt(page, 'return service.ready()')).value
  const restored = await attempt(page, 'return service.restoreBackup(arg)', readFileSync(localBackup, 'utf8'))
  const afterRestore = (await snapshot(page)).value
  check(7, 'Instalasi uji kosong lalu restore tanpa PIN: data identik', freshReady && restored.value && JSON.stringify(afterRestore) === JSON.stringify(before), JSON.stringify(restored.value?.restored ?? restored.error))
  await browser.close()

  // Gate 8: nothing tried to reach the network during any phase.
  check(8, 'Tidak ada request jaringan selama seluruh uji', external.length === 0, external.slice(0, 5).join(', '))

  const shot = join(OUT, 'last-screen.png')
  writeFileSync(shot, execFileSync(ADB, ['exec-out', 'screencap', '-p']))
  const network = { offline, restored: restoreNetwork() }
  try { adb('forward', '--remove', `tcp:${PORT}`) } catch { /* ignore */ }

  const failed = results.filter((r) => !r.ok)
  const report = { at: new Date().toISOString(), device, apk: APK, scope: 'service layer via WebView; UI screens not exercised', network, results, failed: failed.length }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`\n${results.length - failed.length}/${results.length} cek lulus · laporan: ${join(OUT, 'report.json')}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('✗ Uji perangkat berhenti:', e.message)
  try { console.error('Jaringan dipulihkan:', JSON.stringify(restoreNetwork())) } catch { /* ignore */ }
  process.exit(2)
})
