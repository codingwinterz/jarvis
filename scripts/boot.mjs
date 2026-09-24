#!/usr/bin/env node
// EDITH boot — run the assistant as a Windows startup app.
//
//   npm run boot:install   drop a hidden launcher into your Startup folder
//   npm run boot:remove    take it out again
//   npm run boot:stop      end the running session (brain + face + window)
//   node scripts/boot.mjs run   what the launcher calls at logon
//
// `run` starts the brain and the face (scripts/start.mjs) if the UI is not
// already up, waits for it to answer, then opens it as a STANDALONE APP
// WINDOW — no tabs, no address bar — so EDITH reads as a desktop program
// rather than a browser tab. The window is still Chrome (or Edge) underneath,
// deliberately: microphone permission, WebGL, and the browser-speech fallback
// are all tied to that engine, and an embedded webview would quietly lose
// them. The whole thing is idempotent: a launcher that finds the UI already
// serving just reopens the window and exits.
//
// Everything the stack prints is appended to logs/boot.log, because at logon
// the launcher runs with no console attached and stderr goes nowhere.

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STARTUP_DIR = join(
  process.env.APPDATA ?? '',
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'Startup',
)
const LAUNCHER = join(STARTUP_DIR, 'EDITH.vbs')
/** The pre-rename launcher, cleared on install and remove so an upgrade
 *  never leaves two startup entries racing each other at logon. */
const LEGACY_LAUNCHER = join(STARTUP_DIR, 'TRINITY.vbs')
const UI = `http://localhost:${process.env.PORT || 5173}`
const LOG = join(ROOT, 'logs', 'boot.log')

// ---------------------------------------------------------------------------
// HTTP probes
// ---------------------------------------------------------------------------

async function up(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(url, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await up(url)) return true
    await sleep(500)
  }
  return false
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

/**
 * Find Chrome first, then Edge — in the order a machine actually has them.
 * Both accept --app=<url>, which opens a borderless-content window with no
 * tab strip and no address bar: the desktop-program shape, on the browser
 * engine the app's permissions live in.
 */
function findBrowser() {
  const prog = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].filter(Boolean)
  const chrome = [
    ...prog.map((base) => join(base, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    ...(process.env.LOCALAPPDATA
      ? [join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')]
      : []),
  ]
  for (const exe of chrome) if (existsSync(exe)) return { exe, name: 'Chrome' }
  for (const base of prog) {
    const exe = join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    if (existsSync(exe)) return { exe, name: 'Edge' }
  }
  return null
}

/** Open the UI as an app window. Returns which shape actually opened. */
function openWindow() {
  const browser = findBrowser()
  if (browser) {
    spawn(browser.exe, [`--app=${UI}`, '--no-first-run'], {
      detached: true,
      stdio: 'ignore',
    }).unref()
    return `${browser.name} app window`
  }
  // Neither browser found where they normally install — hand the URL to
  // whatever claims http:// on this machine rather than failing silently.
  spawn('cmd', ['/c', 'start', '', UI], { detached: true, stdio: 'ignore' }).unref()
  return 'default browser (Chrome/Edge not found)'
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

/**
 * Write the Startup-folder launcher. VBScript because it can start a process
 * with no console window at all (style 0) — a .bat in Startup would flash a
 * black window over the desktop every sign-in. The absolute paths of THIS
 * node and THIS script are baked in, so the launcher does not depend on PATH
 * or on where npm was installed.
 */
function install() {
  if (!process.env.APPDATA) {
    console.error('  APPDATA is not set — this installer is for Windows.')
    process.exit(1)
  }
  const me = fileURLToPath(import.meta.url)
  mkdirSync(STARTUP_DIR, { recursive: true })
  const vbs = [
    "' EDITH — started automatically at logon.",
    "' Written by `npm run boot:install`; remove with `npm run boot:remove`.",
    'On Error Resume Next',
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = "${ROOT}"`,
    `sh.Run """${process.execPath}"" ""${me}"" run", 0, False`,
    '',
  ].join('\r\n')
  writeFileSync(LAUNCHER, vbs)
  rmSync(LEGACY_LAUNCHER, { force: true })
  console.log('  installed — EDITH now starts itself at every sign-in,')
  console.log('  hidden, and opens as a desktop window once it is ready.')
  console.log(`  launcher: ${LAUNCHER}`)
  console.log('  undo with: npm run boot:remove   stop a session: npm run boot:stop')
}

function remove() {
  rmSync(LAUNCHER, { force: true })
  rmSync(LEGACY_LAUNCHER, { force: true })
  console.log('  removed — EDITH will no longer start at sign-in.')
  console.log('  (Any running session is untouched; npm run boot:stop ends it.)')
}

/**
 * The logon entry point, and the only mode that stays alive.
 *
 * It supervises start.mjs: when either half of the stack dies, start.mjs
 * takes the other down and this process notices, closes the log, and exits —
 * which is also what lets `boot:stop` find the whole tree by this script's
 * command line.
 */
async function run() {
  // Already serving? A second launcher, or a session that survived a reboot
  // via Windows Fast Startup — the UI is there, only the window is missing.
  if (await up(UI)) {
    console.log(`already running at ${UI} — reopening the window.`)
    openWindow()
    return
  }
  if (!existsSync(join(ROOT, 'node_modules'))) {
    console.error('  node_modules is missing — run `npm install` in the EDITH folder once.')
    process.exit(1)
  }
  mkdirSync(dirname(LOG), { recursive: true })
  const log = createWriteStream(LOG, { flags: 'a' })
  log.write(`\n===== boot ${new Date().toISOString()} =====\n`)

  const start = spawn(process.execPath, [join(ROOT, 'scripts', 'start.mjs')], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  start.stdout.pipe(log)
  start.stderr.pipe(log)
  start.on('exit', (code) => {
    log.write(`start.mjs exited (${code}); boot ends.\n`)
    log.end()
    process.exit(code ?? 0)
  })

  console.log(`starting the stack — log: ${LOG}`)
  const ready = await waitFor(UI, 60_000)
  if (!ready) {
    // Leave the supervisor alive: the log pipe stays open and the reason the
    // UI never answered is already in the file.
    console.error('  the UI did not answer within 60s — see logs/boot.log.')
    return
  }
  const shape = openWindow()
  console.log(`ready at ${UI} — opened in a ${shape}.`)
}

/**
 * End the running session. The stack is a tree (boot -> start.mjs ->
 * bridge + vite), and every rung carries this folder's absolute path in its
 * command line — so match on that path and take each tree down with taskkill
 * /T. Matching the path is what keeps this from touching some other project's
 * node processes. $PID guards PowerShell from matching its own query, whose
 * text contains the very pattern being tested.
 */
function stop() {
  const root = ROOT.replace(/'/g, "''")
  const ps = [
    '$m = Get-CimInstance Win32_Process | Where-Object {',
    '  $_.ProcessId -ne $PID -and (',
    `    $_.CommandLine -like '*scripts\\boot.mjs* run*' -or`,
    `    $_.CommandLine -like '*${root}\\scripts\\start.mjs*'`,
    '  )',
    '}',
    'foreach ($p in $m) { taskkill /PID $p.ProcessId /T /F 2>&1 | Out-Null }',
    "if ($m) { 'stopped ' + @($m).Count + ' process(es).' } else { 'nothing to stop — no boot session found.' }",
  ].join('\n')
  const psProc = spawn('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' })
  psProc.on('exit', (code) => process.exit(code ?? 0))
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const modes = { install, remove, run, stop }
const mode = process.argv[2] ?? 'run'
const chosen = modes[mode]
if (!chosen) {
  console.error(`unknown mode "${mode}" — use install | remove | run | stop`)
  process.exit(1)
}
await chosen()
