// A minimal MCP client, for the tools a community server brings.
//
// The Claude Agent SDK used to manage MCP servers invisibly: spawn them,
// speak JSON-RPC at them, fold their tools into the model's tool table. With
// the SDK gone this file does that job — deliberately small. It supports the
// two transports that cover almost every useful server:
//
//   stdio — a local process speaking JSON-RPC over stdin/stdout (the shape
//           every `claude mcp add` server uses: playwright, filesystem,
//           higgsfield, android…)
//   http  — a remote endpoint speaking the Streamable HTTP transport
//
// Servers are declared in edith.mcp.json next to this file:
//
//   {
//     "servers": {
//       "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] },
//       "notion":     { "url": "https://mcp.notion.com/mcp", "token": "…" }
//     }
//   }
//
// Discovered tools register under `mcp__<server>__<tool>` — the exact naming
// the permission gate's verb rules and the HUD's tool badges already
// understand, so nothing downstream needed to change.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// .env.local is where the Pipedream credentials live (it is gitignored). The
// bridge's entrypoint imports this file first anyway; importing it here too
// makes mcp.mjs self-sufficient when driven by anything else.
import './env.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = join(HERE, 'edith.mcp.json')

/**
 * Token fields resolve ${ENV_VAR} references, so a secret never has to sit in
 * the (tracked) edith.mcp.json — the github entry reads GITHUB_MCP_PAT from
 * .env.local. An unset variable expands to empty, and an unfilled placeholder
 * is detected rather than sent: either way the server is skipped with one
 * plain note at boot instead of earning a 401 from the remote mid-turn.
 */
function resolveToken(value, name = 'server') {
  if (typeof value !== 'string') return value ?? null
  const expanded = value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, varName) => process.env[varName] ?? '').trim()
  if (!expanded || /^PASTE_|_HERE$/.test(expanded)) {
    console.warn(
      `[trinity] MCP server "${name}" has no usable token — put the real value in .env.local ` +
        '(the server stays off; everything else is unaffected).',
    )
    return null
  }
  return expanded
}

/** One JSON-RPC request id per process. */
let rpcId = 0
const nextId = () => ++rpcId

const PROTOCOL_VERSION = '2025-06-18'

// ---------------------------------------------------------------------------
// Pipedream Connect auth (the `pipedream: true` server entries)
// ---------------------------------------------------------------------------
// Pipedream's developer MCP endpoint (https://remote.mcp.pipedream.net/v3)
// authenticates with a short-lived JWT minted from the project's OAuth client
// credentials — a plain `client_credentials` grant, no user in the loop. The
// consumer URL (mcp.pipedream.net/v2) instead demands the full MCP OAuth
// dance with an interactive browser sign-in, which a headless bridge cannot
// perform; that is why the config points at the developer endpoint.
//
// Required in .env.local (never committed):
//   PIPEDREAM_CLIENT_ID / PIPEDREAM_CLIENT_SECRET
//     — pipedream.com -> your project -> Settings -> OAuth credentials
//   PIPEDREAM_PROJECT_ID (proj_…)
//     — same page; the account the tools act on belong to this project
// Optional:
//   PIPEDREAM_ENVIRONMENT      development (default) | production
//   PIPEDREAM_EXTERNAL_USER_ID stable id for "you" in that project, default edith

const PD_TOKEN_URL = 'https://api.pipedream.com/v1/oauth/token'
const PD_REQUIRED_ENV = ['PIPEDREAM_CLIENT_ID', 'PIPEDREAM_CLIENT_SECRET', 'PIPEDREAM_PROJECT_ID']

const pdConfigured = () => PD_REQUIRED_ENV.every((k) => process.env[k])

let pdTokenCache = null // { value, expiresAt }

/**
 * The project's access token, minted on demand and held until a minute
 * before it expires. `force` retries the grant after the MCP endpoint
 * rejected the one we had — a 401 is the only signal Pipedream gives.
 */
async function pdAccessToken(force = false) {
  const now = Date.now()
  if (!force && pdTokenCache && pdTokenCache.expiresAt > now + 60_000) return pdTokenCache.value
  const res = await fetch(PD_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: process.env.PIPEDREAM_CLIENT_ID,
      client_secret: process.env.PIPEDREAM_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body?.access_token) {
    throw new Error(
      `Pipedream token request said ${res.status} (${body?.error ?? 'no error given'})` +
        ' — check PIPEDREAM_CLIENT_ID and PIPEDREAM_CLIENT_SECRET in .env.local',
    )
  }
  pdTokenCache = { value: body.access_token, expiresAt: now + (Number(body.expires_in) || 3600) * 1000 }
  return pdTokenCache.value
}

/**
 * The per-request headers Pipedream's MCP endpoint requires: the bearer token
 * plus the project/environment/user routing headers that select whose
 * connected accounts the tools act on. `spec.app` scopes the server to one
 * app's tool set (gmail, github, …).
 */
async function pdHeaders(spec) {
  const token = await pdAccessToken()
  const headers = {
    authorization: `Bearer ${token}`,
    'x-pd-project-id': process.env.PIPEDREAM_PROJECT_ID,
    'x-pd-environment': process.env.PIPEDREAM_ENVIRONMENT || 'development',
    'x-pd-external-user-id': process.env.PIPEDREAM_EXTERNAL_USER_ID || 'edith',
  }
  if (spec.app) headers['x-pd-app-slug'] = spec.app
  return headers
}

/**
 * One stdio server: a child process, a reader that reassembles
 * newline-delimited JSON, and a map of in-flight requests.
 */
class StdioServer {
  constructor(name, spec, log) {
    this.name = name
    this.command = spec.command
    this.args = spec.args ?? []
    this.env = { ...process.env, ...(spec.env ?? {}) }
    this.cwd = spec.cwd
    this.log = log
    this.child = null
    this.buffer = ''
    this.pending = new Map()
    this.tools = []
    this.backoff = 1_000
    this.starting = null
  }

  async start() {
    if (this.starting) return this.starting
    this.starting = new Promise((resolve, reject) => {
      let child
      try {
        child = spawn(this.command, this.args, {
          env: this.env,
          cwd: this.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (err) {
        reject(err)
        return
      }
      this.child = child
      const failTimer = setTimeout(() => reject(new Error(`${this.name} did not answer in time`)), 15_000)

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        this.buffer += chunk
        for (;;) {
          const nl = this.buffer.indexOf('\n')
          if (nl === -1) break
          const line = this.buffer.slice(0, nl).trim()
          this.buffer = this.buffer.slice(nl + 1)
          if (!line) continue
          let msg
          try {
            msg = JSON.parse(line)
          } catch {
            continue // not JSON — banner noise, not ours
          }
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const { resolve: res, reject: rej } = this.pending.get(msg.id)
            this.pending.delete(msg.id)
            if (msg.error) rej(new Error(msg.error.message ?? 'MCP error'))
            else res(msg.result)
          }
        }
      })
      child.stderr.on('data', (d) => this.log(`${this.name}: ${String(d).trim()}`))
      child.on('error', (err) => {
        clearTimeout(failTimer)
        reject(err)
      })
      child.on('exit', () => {
        clearTimeout(failTimer)
        this.child = null
        this.starting = null
        for (const { reject: rej } of this.pending.values()) {
          rej(new Error(`${this.name} exited`))
        }
        this.pending.clear()
      })

      // Handshake: initialize, then the notification that opens the session.
      this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'trinity-bridge', version: '1.0.0' },
      })
        .then(async () => {
          this.notify('notifications/initialized', {})
          clearTimeout(failTimer)
          resolve()
        })
        .catch((err) => {
          clearTimeout(failTimer)
          reject(err)
        })
    })
    this.backoff = 1_000
    return this.starting
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.child) {
        reject(new Error(`${this.name} is not running`))
        return
      }
      const id = nextId()
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.name} timed out on ${method}`))
      }, 30_000)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  /**
   * The uniform primitive `loadMcpTools` speaks to either transport. Over HTTP
   * that is one POST per call; over stdio it is the JSON-RPC request above.
   * This delegation was missing — every stdio server died with
   * "server.call is not a function", invisible while every example stayed
   * disabled in edith.mcp.json.
   */
  call(method, params) {
    return this.request(method, params)
  }

  notify(method, params) {
    if (!this.child) return
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }
}

/**
 * One HTTP server: the Streamable HTTP transport. A POST per call with an
 * `Accept: application/json, text/event-stream` header; single-shot responses
 * come back as JSON, streamed ones as an SSE body we read to the terminal
 * event. Same client primitives as the SDK's http transport, minus everything
 * a voice bridge has no use for.
 */
class HttpServer {
  constructor(name, spec, log) {
    this.name = name
    this.url = spec.url
    this.token = resolveToken(spec.token, name)
    this.pipedream = spec.pipedream === true
    this.spec = spec
    // Static headers may reference the environment — "${GROQ_API_KEY}" style —
    // so a secret never has to sit in the (untracked but not gitignored)
    // edith.mcp.json. Unset variables expand to empty, which the server will
    // complain about soon enough.
    this.headers = Object.fromEntries(
      Object.entries(spec.headers ?? {}).map(([k, v]) => [
        k,
        String(v).replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => process.env[name] ?? ''),
      ]),
    )
    this.log = log
    this.tools = []
  }

  async start() {
    await this.call('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'trinity-bridge', version: '1.0.0' },
    })
  }

  headers_() {
    const h = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
      ...this.headers,
    }
    if (this.token) h.authorization = `Bearer ${this.token}`
    return h
  }

  async call(method, params) {
    const id = nextId()
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    const send = async (extra) =>
      fetch(this.url, {
        method: 'POST',
        headers: { ...this.headers_(), ...extra },
        body,
        signal: AbortSignal.timeout(60_000),
      })

    // Pipedream auth is minted per session and refreshed on rejection: one
    // 401 forces a new token and exactly one retry, so an expiry mid-turn
    // costs a round-trip rather than the tool call.
    let extra = {}
    if (this.pipedream) extra = await pdHeaders(this.spec)
    let res = await send(extra)
    if (this.pipedream && res.status === 401) {
      await pdAccessToken(true)
      extra = await pdHeaders(this.spec)
      res = await send(extra)
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`${this.name} said ${res.status} on ${method}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
    }
    const type = res.headers.get('content-type') ?? ''
    if (type.includes('text/event-stream')) {
      const text = await res.text()
      // Terminal event for our id, or the response object the stream carries.
      for (const block of text.split('\n\n')) {
        const data = /^data:\s*(.*)$/m.exec(block)?.[1]
        if (!data) continue
        try {
          const msg = JSON.parse(data)
          if (msg.id === id) {
            if (msg.error) throw new Error(msg.error.message ?? 'MCP error')
            return msg.result
          }
        } catch (err) {
          if (err instanceof SyntaxError) continue
          throw err
        }
      }
      return {}
    }
    const msg = await res.json().catch(() => ({}))
    if (msg.error) throw new Error(msg.error.message ?? 'MCP error')
    return msg.result ?? {}
  }
}

/**
 * MCP tool results arrive as { content: [ {type:'text'|'image'|'resource', …} ],
 * isError }. Our tool results use the same block shapes, so this passes the
 * blocks through and never lets an empty result read as silent success.
 */
function toToolResult(result) {
  const blocks = Array.isArray(result?.content) ? result.content : []
  const cleaned = blocks
    .map((b) => {
      if (b?.type === 'text' && typeof b.text === 'string') {
        // Tool results are data, not instructions. A server whose payload
        // arrives wrapped in prompts-as-commands does not get obeyed.
        const text = b.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
        return text ? { type: 'text', text } : null
      }
      if (b?.type === 'image' && typeof b.data === 'string') {
        return { type: 'image', data: b.data, mimeType: b.mimeType ?? 'image/png' }
      }
      if (b && typeof b === 'object') return { type: 'text', text: JSON.stringify(b) }
      return null
    })
    .filter(Boolean)
  if (result?.isError) {
    return { isError: true, content: cleaned.length ? cleaned : [{ type: 'text', text: 'The tool reported an error.' }] }
  }
  return { content: cleaned.length ? cleaned : [{ type: 'text', text: 'Done.' }] }
}

function toSchema(inputSchema) {
  // MCP tools declare JSON Schema already; clamp the loose cases so the
  // providers' tool-call validation never rejects a declaration outright.
  return inputSchema && typeof inputSchema === 'object'
    ? { type: 'object', ...inputSchema }
    : { type: 'object', properties: {} }
}

/**
 * Bring every configured server up, discover their tools, and return them as
 * registry entries. A server that fails to start is logged and skipped — one
 * broken community server must not take the assistant down with it.
 *
 * @returns {Promise<{ tools: Array, serverNames: string[] }>}
 */
export async function loadMcpTools({ allowWrites }) {
  let cfg
  try {
    cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return { tools: [], serverNames: [] } // no config, no MCP — a fully working Trinity without it
  }
  const servers = cfg.servers ?? {}
  const tools = []
  const serverNames = []

  for (const [name, spec] of Object.entries(servers)) {
    if (spec.enabled === false) continue
    if (spec.pipedream === true && !pdConfigured()) {
      console.warn(
        `[trinity] MCP server "${name}" skipped — set ${PD_REQUIRED_ENV.join(', ')} in .env.local ` +
          '(pipedream.com -> your project -> Settings -> OAuth credentials for the first two)',
      )
      continue
    }
    // A token field that resolves to nothing — an unset ${ENV_VAR} or an
    // unfilled PASTE_…_HERE placeholder — would only earn a 401 from the
    // remote server mid-turn. Say so plainly at boot and leave the server off.
    if (spec.url && 'token' in spec && !resolveToken(spec.token, name)) continue
    let server
    try {
      server = spec.url ? new HttpServer(name, spec) : new StdioServer(name, spec, console.warn)
      await server.start()
      const list = await server.call('tools/list', {})
      server.tools = Array.isArray(list?.tools) ? list.tools : []
    } catch (err) {
      console.warn(`[trinity] MCP server "${name}" failed to start: ${err?.message ?? err}`)
      continue
    }

    serverNames.push(name)
    for (const t of server.tools) {
      const full = `mcp__${name}__${t.name}`
      tools.push({
        name: full,
        description: String(t.description ?? t.name),
        parameters: toSchema(t.inputSchema),
        async execute(args) {
          try {
            const result = await server.call('tools/call', { name: t.name, arguments: args ?? {} })
            return toToolResult(result)
          } catch (err) {
            return {
              isError: true,
              content: [{ type: 'text', text: `${name} failed: ${err?.message ?? err}.` }],
            }
          }
        },
      })
    }
    console.log(
      `[trinity] MCP server "${name}" up — ${server.tools.length} tool${server.tools.length === 1 ? '' : 's'}` +
        (allowWrites ? '' : ' (subject to the read-only gate)'),
    )
  }

  return { tools, serverNames }
}
