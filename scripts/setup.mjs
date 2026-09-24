#!/usr/bin/env node
// EDITH preflight — a friendly, advisory check you run with `npm run setup`.
//
// It changes nothing and installs nothing. It looks at your machine, tells you
// what is ready and what is missing, and prints the two commands that start
// EDITH. Every check degrades to a single friendly line if something is not
// there, and the script always exits 0 — it is advice, not a gate.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const tick = ' ok '
const warn = ' note '
const info = ' · '

function line(tag, msg) {
  console.log(`[${tag}] ${msg}`)
}

console.log('')
console.log('EDITH preflight — checking your machine (nothing is changed)')
console.log('--------------------------------------------------------------')

// --- Node version --------------------------------------------------------
try {
  const major = Number(process.versions.node.split('.')[0])
  if (Number.isFinite(major) && major >= 20) {
    line(tick, `Node.js ${process.versions.node} (20+ required).`)
  } else {
    line(warn, `Node.js ${process.versions.node} is below 20. Please upgrade — the bridge needs Node 20 or newer.`)
  }
} catch {
  line(warn, 'Could not read the Node.js version. EDITH needs Node 20 or newer.')
}

// --- Provider keys -------------------------------------------------------
// The brain talks to free OpenAI-compatible providers. Either one alone makes
// a working assistant; both give you the hybrid routing (Groq answers the
// conversation, NVIDIA takes the tool-heavy turns, either catches the other's
// rate limits).

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

function envFromFile(name) {
  for (const f of ['.env.local', '.env']) {
    try {
      const raw = readFileSync(join(ROOT, f), 'utf8')
      const m = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*"?([^"\\n]*)"?"?\\s*$`, 'm').exec(raw)
      if (m && m[1].trim()) return { value: m[1].trim(), from: f }
    } catch {
      // no such file
    }
  }
  return null
}

async function probe(base, key) {
  try {
    const res = await fetch(base + '/models', {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return { ok: false, detail: `the key was refused (status ${res.status})` }
    const data = await res.json().catch(() => ({}))
    const ids = (data?.data ?? []).map((m) => m.id).filter(Boolean)
    return { ok: true, detail: `${ids.length} models available`, ids }
  } catch (err) {
    return { ok: false, detail: `could not reach ${base} (${err?.message ?? err})` }
  }
}

const GROQ_BASE = 'https://api.groq.com/openai/v1'
const NVIDIA_BASE = 'https://integrate.api.nvidia.com/v1'

const providers = [
  {
    name: 'Groq (the fast tier)',
    env: 'GROQ_API_KEY',
    base: GROQ_BASE,
    where: 'console.groq.com — free, no card',
    visionRe: /(maverick|scout|vision|vl)/i,
  },
  {
    name: 'NVIDIA (the smart tier)',
    env: 'NVIDIA_API_KEY',
    base: NVIDIA_BASE,
    where: 'build.nvidia.com — free developer key',
    visionRe: /(vl|vision)/i,
  },
]

for (const p of providers) {
  const fromEnv = process.env[p.env]?.trim()
  const fromFile = envFromFile(p.env)
  const key = fromEnv || fromFile?.value
  if (!key) {
    line(warn, `No ${p.env} set — ${p.name} is off.`)
    line(info, `Get a free key at ${p.where}, then put "${p.env}=..." in .env.local.`)
    continue
  }
  const source = fromEnv ? 'the environment' : fromFile.from
  // Live probe — the only check that actually proves the brain works.
  const result = await probe(p.base, key)
  if (result.ok) {
    const vision = (result.ids ?? []).some((id) => p.visionRe.test(id))
    line(tick, `${p.name} — key found in ${source}; ${result.detail}${vision ? '; a vision model is listed (the camera will work)' : ''}.`)
  } else {
    line(warn, `${p.name} — key found in ${source}, but ${result.detail}.`)
  }
}

if (!process.env.GROQ_API_KEY && !envFromFile('GROQ_API_KEY') && !process.env.NVIDIA_API_KEY && !envFromFile('NVIDIA_API_KEY')) {
  line(info, 'With no provider at all EDITH boots and shows the interface, but every question fails.')
}

// --- MCP servers ---------------------------------------------------------
try {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'bridge', 'edith.mcp.json'), 'utf8'))
  const enabled = Object.entries(cfg.servers ?? {}).filter(([, s]) => s.enabled !== false && !s['//'])
  if (enabled.length) {
    line(tick, `${enabled.length} MCP server${enabled.length === 1 ? '' : 's'} configured in bridge/edith.mcp.json.`)
  } else {
    line(info, 'No MCP servers enabled. EDITH works fully without them; add community tools in bridge/edith.mcp.json.')
  }
  // The github entry's token is referenced as ${GITHUB_MCP_PAT} and resolved
  // from the environment at boot — report it like a provider key.
  if (cfg.servers?.github?.enabled !== false) {
    const gh = envFromFile('GITHUB_MCP_PAT')
    if (!gh) {
      line(info, 'No GITHUB_MCP_PAT in .env.local — the github MCP server stays off (free one-time setup: github.com/settings/personal-access-tokens, see README).')
    } else if (/^(github_pat_|ghp_)/.test(gh.value)) {
      line(tick, `GitHub MCP token found in ${gh.from} — the github server comes up at bridge boot.`)
    } else {
      line(warn, `GITHUB_MCP_PAT in ${gh.from} does not look like a fine-grained PAT (expected github_pat_…) — GitHub's MCP server may refuse it.`)
    }
  }
} catch {
  line(info, 'No bridge/edith.mcp.json. EDITH works fully without MCP; see the file for how to add servers.')
}

// --- ElevenLabs key (optional voice) -------------------------------------
function findElevenLabsKey() {
  if (process.env.ELEVENLABS_API_KEY?.trim()) return 'the environment'
  for (const f of ['.env.local', '.env']) {
    try {
      const raw = readFileSync(join(ROOT, f), 'utf8')
      if (/^\s*ELEVENLABS_API_KEY\s*=\s*"\?/.test(raw)) continue
      const m = /^\s*ELEVENLABS_API_KEY\s*=\s*"?([^"\n]*)"?"?\s*$/m.exec(raw)
      if (m && m[1].trim()) return f
    } catch {
      // no such file
    }
  }
  try {
    const parsed = JSON.parse(readFileSync(join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.claude.json'), 'utf8'))
    const el = parsed?.mcpServers?.elevenlabs
    if (el?.env?.ELEVENLABS_API_KEY) return 'the elevenlabs MCP entry in ~/.claude.json'
  } catch {
    // ignore
  }
  return null
}
const elSource = findElevenLabsKey()
const hasGroq = Boolean(process.env.GROQ_API_KEY?.trim() || envFromFile('GROQ_API_KEY'))
const hasFish = Boolean(envFromFile('FISH_API_KEY') && envFromFile('FISH_VOICE_ID'))

// Speech IN: Groq Whisper on the provider key, Scribe on an ElevenLabs key,
// the browser's own recogniser otherwise. (Mirrors sttProvider() in the bridge.)
if (hasGroq) {
  line(tick, 'Mic transcription ready — Groq Whisper, on the Groq key checked above.')
} else if (elSource) {
  line(tick, `Mic transcription ready — ElevenLabs Scribe via ${elSource}.`)
} else {
  line(info, "No transcriber key — the mic uses the browser's own speech recognition (works, but less reliable).")
}

// Speech OUT: Fish, then ElevenLabs, then the browser's own voice.
if (hasFish) {
  line(tick, 'Custom voice ready — Fish Audio speaks through your own voice (free model).')
}
if (elSource) {
  line(tick, `Premium voice available — ElevenLabs key found via ${elSource}.`)
} else if (!hasFish) {
  line(info, 'No ElevenLabs key found — EDITH will use browser speech (that is completely fine).')
  line(info, ' Optional: FISH_API_KEY + FISH_VOICE_ID (free custom voice), or ELEVENLABS_API_KEY.')
}

// --- How to run ----------------------------------------------------------
console.log('')
console.log('To run EDITH, open two terminals:')
console.log('  1) npm run bridge   # the brain (Groq + NVIDIA, your own agent loop)')
console.log('  2) npm run dev      # the face (open http://localhost:5173 in Chrome)')
console.log('')
console.log('Or one command: npm start — then click INITIALISE and say "Edith".')
console.log('To let EDITH take real actions (phone, browser, sending), run `npm run bridge:writes` instead of `npm run bridge`.')
console.log('To start EDITH at Windows sign-in, as a desktop window: `npm run boot:install`.')
console.log('')
process.exit(0)
