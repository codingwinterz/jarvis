// Load .env.local (and .env) for the bridge.
//
// The README has always told you to put your keys in .env.local, and Vite
// reads that file for the FRONTEND — but nothing ever loaded it for the
// bridge, so a GROQ_API_KEY pasted there was invisible to the brain and every
// question failed while `npm run setup` cheerfully reported the key found (it
// reads the file itself). This closes that gap.
//
// Rules, in order of precedence:
//   1. the real process environment always wins — an exported shell variable
//      is an explicit choice and is never clobbered by a file;
//   2. .env.local (the untracked, gitignored file — the right home for keys);
//   3. .env (optional tracked defaults without secrets).
//
// Must be imported FIRST by server.mjs: llm.mjs reads JARVIS_ROUTING and
// friends at module top level, so env vars have to exist before any sibling
// module is evaluated. Key lookups in llm.mjs are lazy, but the routing
// decision is not — hence a side-effect-only module rather than code inline
// after the imports.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Minimal dotenv syntax: KEY=VALUE lines, # comments, optional quoting. */
function load(file) {
  let raw
  try {
    raw = readFileSync(join(ROOT, file), 'utf8')
  } catch {
    return // absent file is normal — .env is optional, .env.local may not exist yet
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    if (!key || key in process.env) continue // shell wins
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}

load('.env.local')
load('.env')
