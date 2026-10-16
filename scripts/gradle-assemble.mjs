// Runs the Gradle wrapper inside android/ from any shell.
// `cd android && gradlew assembleDebug` fails on Windows when
// NoDefaultCurrentDirectoryInExePath is set (cmd/PowerShell then refuse to run
// an executable found only in the current directory), and `./gradlew` is wrong
// on Windows. Resolve an absolute path and let Gradle pick the project with -p.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const android = join(dirname(dirname(fileURLToPath(import.meta.url))), 'android')
const wrapper = join(android, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')
const task = process.argv[2] ?? 'assembleDebug'

/**
 * JAVA_HOME is a User environment variable (docs/ANDROID_SETUP.md), so shells
 * started before it was set — or started by another tool — do not see it and
 * Gradle stops with "JAVA_HOME is not set". Fall back to the installed JDK 21.
 */
function findJdk() {
  if (process.env.JAVA_HOME && existsSync(join(process.env.JAVA_HOME, 'bin', `java${process.platform === 'win32' ? '.exe' : ''}`))) return process.env.JAVA_HOME
  if (process.platform !== 'win32') return process.env.JAVA_HOME
  const roots = [join(process.env.ProgramFiles ?? 'C:/Program Files', 'Eclipse Adoptium'), join(process.env.ProgramFiles ?? 'C:/Program Files', 'Java')]
  for (const root of roots) {
    if (!existsSync(root)) continue
    const jdk = readdirSync(root).filter((d) => /jdk-?21/.test(d) && existsSync(join(root, d, 'bin', 'java.exe'))).sort().pop()
    if (jdk) return join(root, jdk)
  }
  return undefined
}

const javaHome = findJdk()
if (javaHome && javaHome !== process.env.JAVA_HOME) console.log(`JAVA_HOME tidak di-set di shell ini; memakai ${javaHome}`)
const env = { ...process.env, ...(javaHome ? { JAVA_HOME: javaHome } : {}) }

// Node refuses to spawn .bat files directly (EINVAL, CVE-2024-27980), so go through cmd.exe on Windows.
const { status, error } = process.platform === 'win32'
  ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/q', '/s', '/c', `""${wrapper}" -p "${android}" ${task}"`], { stdio: 'inherit', windowsVerbatimArguments: true, env })
  : spawnSync(wrapper, ['-p', android, task], { stdio: 'inherit', env })
if (error) {
  console.error(`Gradle wrapper gagal dijalankan (${wrapper}): ${error.message}`)
  console.error('Pastikan JDK 21 terpasang dan JAVA_HOME mengarah ke sana — lihat docs/ANDROID_SETUP.md.')
  process.exit(1)
}
process.exit(status ?? 1)
