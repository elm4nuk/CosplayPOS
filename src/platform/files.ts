import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'

/**
 * File helpers that work in the Android APK and fall back to a browser download
 * during web development. Nothing here needs a network connection.
 */

export const isNative = () => Capacitor.isNativePlatform()
const FOLDER = 'CosplayPOS'

export type SaveResult = { saved: boolean; location: string; shared?: boolean }

function browserDownload(fileName: string, content: string, mime: string): SaveResult {
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const link = Object.assign(document.createElement('a'), { href: url, download: fileName })
  document.body.append(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return { saved: true, location: `Unduhan/${fileName}` }
}

const isCancel = (reason: unknown) => /cancel/i.test(String((reason as Error)?.message ?? reason))

/**
 * Saves to Documents/CosplayPOS (visible in the Files app, survives uninstall).
 * Android 10 and older need storage permission for this folder; on failure we
 * fall back to the share sheet so the cashier can still put it in Drive/WhatsApp.
 */
export async function saveToDevice(fileName: string, content: string, mime = 'application/json'): Promise<SaveResult> {
  if (!isNative()) return browserDownload(fileName, content, mime)
  try {
    // Granted immediately on Android 11+; shows the storage prompt on 10 and older.
    await Filesystem.requestPermissions()
    await Filesystem.writeFile({ path: `${FOLDER}/${fileName}`, data: content, directory: Directory.Documents, encoding: Encoding.UTF8, recursive: true })
    return { saved: true, location: `Dokumen/${FOLDER}/${fileName}` }
  } catch {
    return shareFile(fileName, content, mime)
  }
}

/** Opens the Android share sheet. A user cancel resolves with `shared: false`. */
export async function shareFile(fileName: string, content: string, mime = 'application/json'): Promise<SaveResult> {
  if (!isNative()) return browserDownload(fileName, content, mime)
  const { uri } = await Filesystem.writeFile({ path: `share/${fileName}`, data: content, directory: Directory.Cache, encoding: Encoding.UTF8, recursive: true })
  try {
    await Share.share({ title: fileName, url: uri, dialogTitle: 'Simpan atau kirim file' })
    return { saved: true, shared: true, location: 'share' }
  } catch (reason) {
    if (isCancel(reason)) return { saved: false, shared: false, location: 'share' }
    throw reason
  }
}

/**
 * Rolling copies inside the app's private storage. They protect against a bad
 * restore or a crash, NOT against uninstall or a lost phone — exports do that.
 */
export async function writeRollingBackup(content: string, keep = 5) {
  if (!isNative()) return
  const dir = `${FOLDER}/auto`
  const name = `auto-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  await Filesystem.writeFile({ path: `${dir}/${name}`, data: content, directory: Directory.Data, encoding: Encoding.UTF8, recursive: true })
  const { files } = await Filesystem.readdir({ path: dir, directory: Directory.Data })
  const old = files.map((f) => f.name).filter((n) => n.startsWith('auto-')).sort().slice(0, -keep)
  await Promise.all(old.map((n) => Filesystem.deleteFile({ path: `${dir}/${n}`, directory: Directory.Data })))
}

export async function listRollingBackups() {
  if (!isNative()) return []
  try {
    const { files } = await Filesystem.readdir({ path: `${FOLDER}/auto`, directory: Directory.Data })
    return files.map((f) => f.name).filter((n) => n.startsWith('auto-')).sort().reverse()
  } catch { return [] }
}

export async function readRollingBackup(name: string) {
  const { data } = await Filesystem.readFile({ path: `${FOLDER}/auto/${name}`, directory: Directory.Data, encoding: Encoding.UTF8 })
  return typeof data === 'string' ? data : await data.text()
}

export const backupFileName = (date = new Date()) => `cosplaypos-backup-${date.toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`
