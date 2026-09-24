// TRINITY brain transport.
//
// One OpenAI-compatible client, two free providers, one traffic controller.
// Every turn starts on the fast provider (Groq's LPUs — chitchat answered in a
// heartbeat); the moment a reply carries tool_calls, the rest of the loop is
// promoted to the smart provider (NVIDIA's Nemotron 3), which is where agentic
// work belongs. Escalation also happens on 429, timeout, 5xx and
// context-too-large, so a rate limit on one provider bends the turn onto the
// other instead of breaking it.
//
// Both providers speak the same dialect (the OpenAI chat completions wire
// format), so this file is the ONLY vendor-specific code in the bridge: adding
// a provider is one entry in PROVIDERS and nothing else.
//
// Deliberately built on the `openai` package pointed at custom base URLs
// rather than hand-rolled fetch: it gives us SSE parsing, streaming chunks,
// typed errors carrying HTTP status, and retries we can reason about.

import OpenAI from 'openai'

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

const GROQ_BASE = 'https://api.groq.com/openai/v1'
const NVIDIA_BASE = 'https://integrate.api.nvidia.com/v1'

/**
 * The fast tier. Groq hosts a rotating cast of open models and the exact slug
 * drifts a few times a year; the default below is the long-stable versatile
 * slug, and `resolveModel` (below) self-heals against the provider's own
 * /models list when a slug has been retired. Override with JARVIS_GROQ_MODEL.
 */
const GROQ_MODEL_DEFAULT = 'llama-3.3-70b-versatile'

/**
 * The smart tier. Verified against the live catalogue: Nemotron 3 Super
 * (nvidia/nemotron-3-super-120b-a12b) is the plan's pick — snappier than the
 * 550B Ultra, still a top-tier tool caller. If the slug is ever retired,
 * resolveModel self-heals to the best family match on the catalogue.
 * Override with JARVIS_NEMOTRON_MODEL.
 */
const NVIDIA_MODEL_DEFAULT = 'nvidia/nemotron-3-super-120b-a12b'

const PROVIDERS = {
  groq: {
    label: 'Groq',
    baseURL: GROQ_BASE,
    key: () => process.env.GROQ_API_KEY ?? null,
    model: () => process.env.JARVIS_GROQ_MODEL ?? GROQ_MODEL_DEFAULT,
    /** Groq's OpenAI-compatible endpoint wants no extra template controls. */
    extraBody: () => ({}),
    /** Client-side cap; the true free-tier limits are unpublished and move. */
    timeoutMs: 60_000,
    visionRe: /(maverick|scout|vision|vl)/i,
  },
  nvidia: {
    label: 'NVIDIA',
    baseURL: NVIDIA_BASE,
    key: () => process.env.NVIDIA_API_KEY ?? null,
    model: () => process.env.JARVIS_NEMOTRON_MODEL ?? NVIDIA_MODEL_DEFAULT,
    /**
     * Nemotron 3 generates a reasoning trace first and answers second. A voice
     * assistant cannot afford the trace on a spoken turn, and the trace would
     * either be spoken or have to be stripped — so it is switched off at the
     * chat-template level. Override with JARVIS_THINKING=1 for heavy demos.
     */
    extraBody: () =>
      process.env.JARVIS_THINKING === '1'
        ? {}
        : { chat_template_kwargs: { enable_thinking: false } },
    timeoutMs: 120_000,
    visionRe: /(vl|vision)/i,
  },
}

/** Escalation order: fast first, smart as the safety net. */
const ROUTE_ORDER = process.env.JARVIS_ROUTE === 'smart-first'
  ? ['nvidia', 'groq']
  : ['groq', 'nvidia']

const ROUTING = process.env.JARVIS_ROUTING ?? 'hybrid'
// 'hybrid'   — fast first, promote on tool use or failure
// 'groq'     — fast tier only (one connection, fewer moving parts)
// 'nemotron' — smart tier only

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const clients = new Map()

function clientOf(name) {
  const p = PROVIDERS[name]
  const key = p.key()
  if (!key) return { client: null, error: `no ${name} API key` }
  let entry = clients.get(name)
  if (!entry) {
    entry = new OpenAI({
      apiKey: key,
      baseURL: p.baseURL,
      timeout: p.timeoutMs,
      maxRetries: 0, // retries are ours to schedule, with escalation attached
    })
    clients.set(name, entry)
  }
  return { client: entry, error: null }
}

/**
 * A request that is worth retrying on the OTHER provider, or again on this
 * one. Status-carrying errors from the SDK make this a clean read.
 */
function escalatable(err) {
  const status = err?.status
  if (status === 429 || status === 408 || status === 504) return true
  // 413 is Groq's shape of "you are over the per-minute token budget" — the
  // request itself may be perfectly fine and the MINUTE is full. That is
  // retryable by definition, and the other provider's budget is the better
  // place to spend the turn: without this, a turn bigger than the free tier's
  // 8k TPM dies where a healthy Nemotron was one hop away.
  if (status === 413) return true
  if (status === 401 || status === 403) return true // bad key on one ≠ the other
  if (status >= 500) return true
  if (status === 400) {
    // Context overflow reads differently per host, but 'length' is common to
    // both. A 400 that is our fault (bad schema) will fail on both anyway.
    return /context|length|too (large|long|many)/i.test(String(err?.message ?? ''))
  }
  // Connection-level failures: DNS, refused, reset, timeout.
  return !status
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

const modelCache = new Map()

/**
 * Fetch a provider's model catalogue. Cheap, called at most once per provider
 * per process, and used both to self-heal a drifted slug and to pick a vision
 * model. Returns null when the catalog is unreachable — the configured slug
 * is then passed through as-is and the provider's own 404 tells the truth.
 */
async function catalog(name) {
  if (modelCache.has(name)) return modelCache.get(name)
  const { client } = clientOf(name)
  if (!client) return null
  try {
    const list = await client.models.list()
    const ids = (list.data ?? []).map((m) => m.id).filter(Boolean)
    modelCache.set(name, ids)
    return ids
  } catch {
    return null
  }
}

/**
 * Turn a configured model name into one the provider will actually accept.
 *
 * The rule, in order: an explicitly configured model is honoured if it is
 * listed; otherwise the best family match from the catalogue wins (Super
 * preferred over Ultra for pace on NVIDIA, the newest versatile model on
 * Groq); otherwise the configured name is passed through untouched so the
 * provider's error message names the real problem.
 */
async function resolveModel(name) {
  const p = PROVIDERS[name]
  const wanted = p.model()
  const ids = await catalog(name)
  if (!ids?.length) return wanted
  if (ids.includes(wanted)) return wanted

  if (name === 'nvidia') {
    const family = ids.filter((id) => /^nvidia\/nemotron-3/i.test(id))
    if (family.length) {
      const pick =
        family.find((id) => /super/i.test(id)) ??
        family.find((id) => /ultra/i.test(id)) ??
        family[0]
      console.warn(`[trinity] ${p.label} model "${wanted}" is not listed — using "${pick}".`)
      return pick
    }
  }
  if (name === 'groq') {
    const versatile = ids
      .filter((id) => /versatile|70b|gpt-oss/i.test(id))
      .filter((id) => !/preview|deprecated/i.test(id))
    if (versatile.length) {
      console.warn(`[trinity] ${p.label} model "${wanted}" is not listed — using "${versatile[0]}".`)
      return versatile[0]
    }
  }
  return wanted
}

/** Pick a vision-capable model on the given provider, for the camera tools. */
async function resolveVisionModel(name) {
  const ids = await catalog(name)
  if (!ids?.length) return null
  const p = PROVIDERS[name]
  return ids.find((id) => p.visionRe.test(id) && !/deprecated|preview/i.test(id)) ?? null
}

// ---------------------------------------------------------------------------
// Thinking-trace hygiene
// ---------------------------------------------------------------------------

/**
 * Nemotron (and any other reasoning model) may still emit a <think>…</think>
 * trace in its visible content — when thinking is enabled explicitly, or when
 * a future model renames the switch. Spoken text must never contain it, so it
 * is stripped defensively from both streamed deltas and final content. The
 * strip is stateful per stream because the tag can straddle chunk boundaries.
 */
function makeTraceStripper() {
  let pending = ''
  let inTrace = false
  return (delta) => {
    if (inTrace) {
      pending += delta
      const close = pending.indexOf('</think>')
      if (close === -1) {
        // Keep only a tail: the close tag itself is the longest thing worth
        // holding, and an unbounded buffer here would grow for a whole trace.
        pending = pending.slice(-16)
        return ''
      }
      pending = pending.slice(close + 8)
      inTrace = false
      delta = ''
    }
    let out = pending + delta
    pending = ''
    const open = out.indexOf('<think>')
    if (open !== -1) {
      const before = out.slice(0, open)
      const rest = out.slice(open + 7)
      const close = rest.indexOf('</think>')
      if (close === -1) {
        inTrace = true
        pending = rest.slice(-16)
        return before
      }
      // Closed within the same chunk; whatever follows may even open another.
      return before
    }
    // Hold back a tail that could be the start of a tag. Everything from the
    // last '<' onward waits for one more chunk to prove it is prose.
    const hold = out.lastIndexOf('<')
    if (hold !== -1 && out.length - hold < 8) {
      pending = out.slice(hold)
      return out.slice(0, hold)
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// One streamed completion
// ---------------------------------------------------------------------------

/**
 * Stream one chat completion from one provider, accumulating text and tool
 * calls. `onDelta` receives text as it arrives (already trace-stripped) so
 * the bridge can start speaking on the first finished sentence.
 */
async function streamOnce(name, model, { messages, tools, onDelta, signal }) {
  const p = PROVIDERS[name]
  const { client, error } = clientOf(name)
  if (!client) {
    const err = new Error(error)
    err.status = 0
    throw err
  }

  const strip = makeTraceStripper()
  const contentParts = []
  const toolCalls = []
  /** tool-call accumulation, keyed by stream index */
  const partial = new Map()
  let finishReason = null
  let usage = null

  const stream = await client.chat.completions.create(
    {
      model,
      messages,
      ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.6,
      max_tokens: Number(process.env.JARVIS_MAX_TOKENS) || 1024,
      ...p.extraBody(),
    },
    { signal },
  )

  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage
    const choice = chunk.choices?.[0]
    if (!choice) continue
    if (choice.finish_reason) finishReason = choice.finish_reason

    const delta = choice.delta
    if (!delta) continue

    if (typeof delta.content === 'string' && delta.content.length) {
      const out = strip(delta.content)
      if (out) {
        contentParts.push(out)
        onDelta?.(out)
      }
    }

    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0
      let slot = partial.get(idx)
      if (!slot) {
        slot = { id: tc.id ?? '', name: '', args: '' }
        partial.set(idx, slot)
      }
      if (tc.id) slot.id = tc.id
      if (tc.function?.name) slot.name += tc.function.name
      if (tc.function?.arguments) slot.args += tc.function.arguments
    }
  }

  for (const slot of partial.values()) {
    if (!slot.name && !slot.id) continue
    toolCalls.push({
      id: slot.id || `call_${toolCalls.length}`,
      type: 'function',
      function: { name: slot.name, arguments: slot.args || '{}' },
    })
  }

  return {
    provider: name,
    model,
    content: contentParts.join(''),
    toolCalls,
    finishReason,
    usage,
  }
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

/**
 * One model turn, routed.
 *
 * `route` names the provider to try first. On an escalatable failure the other
 * provider gets the request — that is the whole resilience story of a hybrid
 * brain: a rate limit on either free tier bends the turn rather than breaking
 * it. One retry with a short backoff per provider, capped so a dead network
 * fails a turn in tens of seconds rather than minutes.
 */
export async function complete({ messages, tools, route = 'groq', onDelta, signal }) {
  const order =
    ROUTING === 'groq' ? ['groq']
    : ROUTING === 'nemotron' ? ['nvidia']
    : route === 'nvidia' ? ['nvidia', 'groq']
    : ['groq', 'nvidia']

  let lastErr = null
  for (const name of order) {
    // Whatever has already streamed is already in the listener's ears — track
    // it so a mid-stream failure can be KEPT instead of regenerated. A retry
    // from scratch would replay the turn over the top of the sentence
    // currently being spoken: the cut-pause-restart glitch, verbatim.
    let delivered = ''
    const speak = (d) => {
      delivered += d
      onDelta?.(d)
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const model = await resolveModel(name)
      try {
        return await streamOnce(name, model, { messages, tools, onDelta: speak, signal })
      } catch (err) {
        if (signal?.aborted) throw err
        lastErr = err
        const status = err?.status
        if (delivered) {
          console.warn(
            `[trinity] ${PROVIDERS[name].label} dropped mid-stream after ${delivered.length} chars — keeping the partial reply`,
          )
          return {
            provider: name,
            model,
            content: delivered,
            toolCalls: [],
            finishReason: null,
            usage: null,
            partial: true,
          }
        }
        console.warn(
          `[trinity] ${PROVIDERS[name].label} attempt ${attempt + 1} failed` +
            (status ? ` (status ${status})` : '') + `: ${err?.message ?? err}`,
        )
        if (!escalatable(err)) throw err
        // Backoff only on a rate limit, and only before the second attempt.
        if (status === 429 && attempt === 0) {
          await new Promise((r) => setTimeout(r, 1_500))
        }
      }
    }
    // Fall through to the next provider in the order.
  }
  throw lastErr ?? new Error('no provider available')
}

/**
 * Which provider a turn should START on.
 *
 * The hybrid policy sends conversation to the fast tier and only promotes to
 * the smart tier when the reply asks for tools — see promoteRoute in
 * server.mjs. `smart-first` (JARVIS_ROUTE=smart-first) inverts the order for
 * demos where quality matters more than pace.
 */
export const initialRoute = () =>
  ROUTING === 'nemotron' || ROUTE_ORDER[0] === 'nvidia' ? 'nvidia' : 'groq'
export const promoteRoute = () => 'nvidia'

// ---------------------------------------------------------------------------
// Vision
// ---------------------------------------------------------------------------

/**
 * One image-in, text-out question — the camera tools' second hop.
 *
 * The main brain may be text-only (Nemotron 3 is), so a frame is described by
 * whichever vision-capable model the providers list, tried fast-tier first.
 * The frame travels as a data URL, which every OpenAI-compatible vision
 * endpoint accepts; nothing is written to disk.
 */
export async function describeImage({ data, mimeType = 'image/jpeg', prompt, signal }) {
  const message = {
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}` } },
    ],
  }

  for (const name of ROUTE_ORDER) {
    if (!PROVIDERS[name].key()) continue
    try {
      const model = (await resolveVisionModel(name)) ?? (await resolveModel(name))
      const out = await streamOnce(name, model, {
        messages: [message],
        tools: [],
        signal,
        onDelta: undefined,
      })
      return { text: out.content.trim(), provider: name, model }
    } catch (err) {
      if (signal?.aborted) throw err
      console.warn(`[trinity] vision on ${PROVIDERS[name].label} failed: ${err?.message ?? err}`)
    }
  }
  throw new Error('no vision-capable provider answered')
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/** What each provider reports — for setup.mjs, the boot banner, and /health. */
export async function probeProviders() {
  const out = {}
  for (const [name, p] of Object.entries(PROVIDERS)) {
    const { error } = clientOf(name)
    const entry = { configured: !error, error: error ?? null, model: p.model() }
    if (entry.configured) {
      const ids = await catalog(name)
      entry.ok = Array.isArray(ids)
      entry.models = ids?.length ?? 0
      if (ids && !ids.includes(p.model())) {
        entry.resolvedModel = await resolveModel(name)
      }
    }
    out[name] = entry
  }
  return out
}
