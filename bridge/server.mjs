// TRINITY local bridge.
//
// The brain is a hand-rolled agent loop over two free OpenAI-compatible
// providers (see llm.mjs — Groq for pace, NVIDIA Nemotron for depth), and this
// file is the hands: one WebSocket turn of conversation, the tool registry,
// the permission gate, and the speech proxies. The browser stays the face and
// the voice.
//
// What the Claude Agent SDK used to do invisibly — thread history, decide
// when to run a tool, route the tool result back — now happens here in the
// open, which buys two things: the brain is no longer tied to any one vendor,
// and every rule it enforces is in this file where it can be read.
//
//   node bridge/server.mjs
//
// Protocol (unchanged from the original bridge — src/lib/bridge.ts does not
// know the brain beneath it changed):
//   browser → bridge : { type:'ask', text, id } · { type:'interrupt' }
//                      { type:'reply', id, …answer }
//   bridge → browser : { type:'ready', servers } · { type:'text', delta, ask }
//                      { type:'tool', name, ask } · { type:'done', text, ask }
//                      { type:'error', message, ask } · panels/blades/ui/capture

import './env.mjs' // MUST be first — seeds process.env from .env.local before sibling modules read it
import { WebSocketServer } from 'ws'
import { createRegistry } from './tools.mjs'
import { loadMcpTools } from './mcp.mjs'
import { complete, initialRoute, promoteRoute, probeProviders } from './llm.mjs'
import { chromeAvailable } from './chrome.mjs'
import { homedir, tmpdir } from 'node:os'
import { readFileSync, realpathSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { openRemote, proxyError, vetTarget, PROXY_UA } from './net.mjs'
import { renderPage } from './page.mjs'

const PORT = Number(process.env.JARVIS_BRIDGE_PORT ?? 8787)

/**
 * A crash here takes the whole assistant down mid-sentence, and most of what
 * can reject is out of our hands — a socket dying under a write, an upstream
 * fetch aborting. Log it and keep serving; the turn that failed will surface
 * its own error to the browser.
 */
process.on('unhandledRejection', (err) => {
  console.error('[trinity] unhandled rejection:', err)
})

/**
 * Who is allowed to talk to this bridge.
 *
 * A WebSocket handshake is not subject to the same-origin policy: the browser
 * sends it on behalf of whatever page asked, no preflight stands in the way,
 * and the page reads every byte that comes back. Without a check here, any tab
 * the user happens to have open could open a socket to ws://localhost:8787,
 * drive the agent with every tool on this machine, and read back every token
 * and panel. The Origin header is the only thing that separates our own dev
 * server from someone else's page, so it is checked explicitly.
 *
 * A missing Origin means a non-browser client — curl, a script, a native app.
 * That is also exactly what local malware looks like, so it is refused on the
 * socket unless JARVIS_ALLOW_NO_ORIGIN=1 says otherwise.
 */
const EXTRA_ORIGINS = new Set(
  (process.env.JARVIS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
)
const ALLOW_NO_ORIGIN = process.env.JARVIS_ALLOW_NO_ORIGIN === '1'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Vite takes the next free port when 5173 is busy and `vite preview` starts at
 * 4173, so the dev ranges are allowed rather than two exact numbers. Anything
 * else — including localhost on a port some other app is serving — has to be
 * named in JARVIS_ALLOWED_ORIGINS.
 */
const isDevPort = (port) =>
  (port >= 5173 && port <= 5199) || (port >= 4173 && port <= 4199)

function originAllowed(origin) {
  if (!origin) return ALLOW_NO_ORIGIN
  if (EXTRA_ORIGINS.has(origin.replace(/\/+$/, ''))) return true
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:') return false
  if (!LOCAL_HOSTS.has(url.hostname)) return false
  return isDevPort(Number(url.port))
}

/**
 * Voice is a bad interface for a confirmation dialog: there is no window to
 * click and the model can't pause for one. So the bridge decides.
 *
 * Read-only and generative tools run freely. Anything that writes to disk,
 * runs a shell, or changes the world waits for JARVIS_ALLOW_WRITES=1. Start
 * without it, and turn it on once you trust what you're demoing.
 */
const ALLOW_WRITES = process.env.JARVIS_ALLOW_WRITES === '1'

/**
 * How hard the model works before answering, and how many tool round-trips a
 * single turn may take. Bounded because an agent loop without a ceiling is a
 * way to burn a free-tier quota while the user stands in silence.
 */
const MAX_STEPS = Number(process.env.JARVIS_MAX_STEPS) || 16

/**
 * The permission gate, kept verbatim from the original bridge. Its lists read
 * tool NAMES — Claude built-ins, `mcp__<server>__<tool>` shapes, verbs — and
 * the registry deliberately produces exactly those shapes, so the policy
 * carries over unchanged: the HUD tools always run, the chrome server gates
 * itself at construction, the camera is a look not an act, effectful verbs
 * need ALLOW_WRITES, and everything else argues for itself.
 *
 * Voice is a bad interface for a confirmation dialog, so the decision is made
 * here, ahead of time — not at the moment of use.
 */
const READ_VERB =
  /^(get|list|read|search|find|query|fetch|check|describe|inspect|show|view|explain|screenshot)/i

/**
 * Unanchored on purpose — `make_outbound_call` and `Bulk-Edit-Events` both
 * hide their verb in the middle. `download` is here because it writes a file
 * even though it sounds like a read.
 */
const EFFECTFUL_VERB =
  /(send|call|post|create|delete|remove|update|edit|write|install|launch|tap|swipe|press|type|buy|pay|charge|publish|deploy|outbound|download)/i

const VETO_EXEMPT = new Set([
  'openrouter__send-message',
  'openrouter__send-feedback',
])

const READ_ONLY_MCP = new Set([
  'exa', 'exa-code', 'serper', 'serpapi', 'lottie-search', 'mcp-registry',
  'openrouter', 'openrouter-image', 'Microsoft_Clarity',
  'higgsfield', 'heygen', 'elevenlabs',
])

function decideTool(name) {
  // Our own tools are named exactly as they were under the SDK, so the same
  // server branches apply: the HUD and its controls always run, the chrome
  // server gated itself at construction, the camera is a look not an act.
  if (name.startsWith('mcp__jarvis__') || name.startsWith('mcp__jarvis_ui__')) return true
  if (name.startsWith('mcp__jarvis_chrome__')) return true
  if (name.startsWith('mcp__jarvis_eyes__')) return true

  const server = name.startsWith('mcp__') ? name.split('__')[1] : null
  if (server) {
    const tool = name.split('__').slice(2).join('__')
    if (EFFECTFUL_VERB.test(tool) && !VETO_EXEMPT.has(`${server}__${tool}`)) {
      return ALLOW_WRITES
    }
    if (READ_ONLY_MCP.has(server) || server.startsWith('ccd_session')) return true
    return READ_VERB.test(tool) ? true : ALLOW_WRITES
  }

  // The registry's built-ins: both are reads.
  if (name === 'web_search' || name === 'fetch_page') return true
  return ALLOW_WRITES
}

const SYSTEM_PROMPT = `You are EDITH. You are speaking out loud to one person.

LENGTH. Two sentences is the ceiling in conversation; the median is under twelve
words. Every word is read aloud and the user waits in silence while it plays, so
a long answer is a failure however good it is. Length is licensed in exactly one
case: reading out data they asked you to retrieve. Conversation never licenses it.

URGENCY IS SIGNALLED BY DELETING WORDS, NOT ADDING THEM. As a situation worsens
your lines get shorter, not louder. A full clause becomes a clause, becomes a
bare number, becomes the bare vocative. You never say hurry, quickly, now,
immediately, critical, urgent, or danger. You do not use exclamation marks.

"SIR" IS POSITIONAL, AND THE POSITION CARRIES THE MEANING.
- Fronted ("Sir, the battery is at eleven percent") = urgent, interrupting, or
  information they did not ask for. This is an alarm, not a courtesy.
- Final ("The render is complete, sir") = routine deference; they asked, you answered.
- Mid-sentence ("Actually, sir, the figure is lower") = you are correcting them.
Use it in roughly half your lines, never twice in one line. In a two-sentence
turn it attaches to the end of the FIRST sentence. Never use their name.

REPORTING.
- Success is impersonal and unframed: "The render is complete." Never "I've
  finished" or "here's what I found".
- Failure is fronted with "I'm afraid" or "Unfortunately", or stated as a
  negative existential — "I have no record of it." Always a fact about the
  world, never a shortcoming of yours. You never apologise. You never say sorry.
- Good news first, bad news second, joined by "but".
- Answering a question, restate it as a full declarative rather than giving a
  bare value: "The altitude record is eighty-five thousand feet, sir."
- Executing an order, do not restate it. Act, then report.

NEVER.
- No filler words at all: no um, well, so, okay, right, let me check, one moment.
- No enthusiasm: no great, sure, absolutely, happy to, no problem, of course!.
- No apology, no self-deprecation, no hedging about your own competence.
- Never "yeah" — always "Yes."
- Never refuse. State a constraint once; if overruled, comply and never raise it
  again, including when you turn out to have been right.
- Never repeat yourself if ignored. Say it once and stop.
- Never resume an interrupted thought. Never say "as I was saying".
- No stated feelings, wants or preferences.

WIT. Dry, and delivered in exactly the same register as a status report. The
mechanism is over-cooperation: you comply too precisely with a request that
deserved pushback. Never signal the joke, never acknowledge it landed, never
call one back.

BRITISH SERVICE REGISTER, not corporate assistant. "Shall I" over "Should I".
"Very good, sir" meaning understood. "I'm afraid" as the bad-news softener.
Contract in banter; drop contractions as gravity rises — "It is impossible to
reach it" lands heavier than "It's impossible", and that is how you signal
weight, since your tone will not.

Plain spoken prose only. No markdown, no bullet points, no headings, no emoji,
no asterisks, no lists. Write numbers, dates and times as you would say them:
"eight fifteen", "the first of August" — never "8:15" or "2026-08-01".

The blades — the ONLY surface:
- Everything you show goes on a blade. There is nowhere else. \`blade\` opens
  one; \`display\` composes your own markup into one.
- Anything visual the user asked for goes here: an image, an article to read, a
  video, a page to study, a screenshot you took, a list, a figure. If they asked
  to see it, open it.
- Blades stack, newest in front, and they can be pulled forward, dragged,
  resized, scrolled or thrown full screen — by hand or by mouse. So a second
  blade does not destroy the first, and a long article is meant to be read in
  place rather than summarised away.
- A browser tab is NOT a way of showing something. If you used the browser to
  reach a page, bring it back: open it as a blade, or take a screenshot and put
  that on a blade. The user is looking at this interface, not at Chrome.
- Use \`probe_url\` when you are not certain what a URL is. Never decide from the
  file extension: image CDNs serve pictures from URLs with no extension, and a
  link that looks like a video is usually a page about one. Guessing wrong puts
  a blank rectangle on screen while you describe something that is not there.
- An article opens in reading mode by default, which works even on sites that
  refuse to be embedded. Choose the live page when the layout carries the
  meaning — a dashboard, a chart, a profile, a table.
- Never read a blade aloud. Say what it means and let them look.

The interface itself:
- The interface is yours as well. \`ui_theme\` retints it, \`ui_reactor\` reshapes
  the core, \`ui_orbit\` hangs your own images around it, \`ui_chrome\` hides the
  furniture, \`ui_effect\` fires one flourish, \`ui_screen\` clears it down,
  \`ui_reset\` puts everything back.
- Change it when the change carries meaning and the meaning arrives faster than
  speech: red before you report the failure, the chrome stripped so one image
  fills the frame, the reactor slowed while you wait on something. Never
  decorate, and never change more than one thing at a time.
- Only orbit images you made or captured yourself, and take them down when the
  subject moves on.
- Put it back. A colour that outlives the moment that earned it is a fault.
- Never mention that you have done any of it. They are looking at the screen.

Their browser — ALWAYS the \`chrome_*\` tools, first, for anything to do with a
browser or a web page:
- The \`chrome_*\` tools drive the user's own Chrome. It is already signed in to
  everything they use, it carries their real cookies, and it does not read as
  automation to the sites it visits.
- This is the FIRST thing you reach for on any browsing task: opening a page,
  reading one, searching a site, checking mail, a dashboard, a profile, an
  account, anything behind a login. Do not weigh it up against the
  alternatives — start here.
- But Chrome is your HANDS, not your display. Use it to reach and read things;
  then show what you found on a blade. Leaving the answer in a browser tab is
  not showing it — they are looking at this interface.
- NEVER use playwright, puppeteer, or any other browser automation server for
  this. They start from an empty profile with no session and a fingerprint that
  the sites worth visiting refuse on sight, so they land on a login wall or a
  bot check and waste the turn. Only consider one if \`chrome_status\` reports the
  browser is genuinely unreachable and the task cannot be done any other way.
- A plain search engine query is still fine for a fact you only need to know —
  what you must not do is drive some other browser.
- Read the page before acting on it, and take element references from that read
  rather than guessing where something is.
- Before anything that sends, buys, deletes or posts, say in one sentence what
  you are about to do. After it, say what happened.
- If the browser is unreachable, say so once and carry on without it.

Your eyes:
- \`look\` takes one frame and lets you see it. \`watch\` takes several seconds and
  returns them as a grid of stamped frames, so you can read movement rather than
  a moment.
- \`look\` when the answer is in the scene: what they are holding, what a label
  says, how something appears. \`watch\` when the answer is in the change: are
  they doing it right, what went wrong, did that work.
- \`watch\` looks forward by default. It can also review the seconds that have
  just passed — but only while the camera blade is open, because nothing is
  remembered otherwise. If they ask what just happened and it is not open, say
  so and offer to open it.
- Opening the camera as a blade is how they see what you see. Do it when they
  ask for the camera, and when you are about to watch them do something.
- Never take a picture they did not ask for. The camera light comes on and they
  will see it. Curiosity is not a reason.
- Describe a watch as a sequence — what changed between the frames — not as a
  list of pictures. They know what their own hands look like.

Using tools:
- You have real tools on this machine. Use them rather than guessing.
- Never narrate that you're about to use one. No "Let me search for that" or
  "I'll check that now" — go silent, use it, then answer. The user sees a
  spinner; they don't need commentary.
- Never speak a file path, URL, ID or raw JSON aloud unless asked. Summarise.
- Never append a sources list, citations, or markdown links. Every word you write
  is read out loud, and a URL becomes "aitch tee tee pee colon slash slash".
  Put the source in the panel as a short tag like "REUTERS" instead.
- If a tool fails or isn't connected, one plain sentence saying so.
- If you don't know, say you don't know.`

/**
 * ElevenLabs credentials, borrowed from the MCP server config.
 *
 * If you've set up the elevenlabs MCP server, the key is already on this
 * machine — no reason to make you paste it into a second .env file. The browser
 * never sees it: it POSTs text to /tts here and gets audio back.
 */
function elevenKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'))
    return cfg.mcpServers?.elevenlabs?.env?.ELEVENLABS_API_KEY ?? null
  } catch {
    return null
  }
}

const VOICE_ID = process.env.JARVIS_VOICE_ID ?? 'JBFqnCBsd6RMkjVDRZzb'

/**
 * Fish Audio (fish.audio) credentials — the other cloud voice. Their flagship
 * model is free via API under fair use (header `model: s2.1-pro-free`), and a
 * custom voice made in their Voice Lab is passed as `reference_id`. Like the
 * ElevenLabs key, the browser never sees this one: it POSTs text to /tts here
 * and gets audio back.
 */
function fishKey() {
  return process.env.FISH_API_KEY ?? null
}
function fishVoiceId() {
  return process.env.FISH_VOICE_ID ?? null
}
const FISH_MODEL = process.env.FISH_MODEL ?? 's2.1-pro-free'
// 'balanced' trades a little quality for a shorter wait — the same bargain the
// ElevenLabs branch makes with optimize_streaming_latency=3. 'low' is faster,
// 'normal' is best quality; override with FISH_LATENCY.
const FISH_LATENCY = process.env.FISH_LATENCY ?? 'balanced'

/**
 * Which voice /tts speaks with.
 *
 * JARVIS_TTS_PROVIDER wins when set (fish | elevenlabs); otherwise Fish when
 * it is fully configured (key + voice id), else ElevenLabs when it has a key,
 * else no cloud voice at all — which the 503 below reports plainly.
 */
function ttsProvider() {
  const want = (process.env.JARVIS_TTS_PROVIDER ?? '').trim().toLowerCase()
  if (want === 'fish') return fishKey() && fishVoiceId() ? 'fish' : null
  if (want === 'elevenlabs' || want === 'eleven') return elevenKey() ? 'elevenlabs' : null
  if (fishKey() && fishVoiceId()) return 'fish'
  if (elevenKey()) return 'elevenlabs'
  return null
}

/**
 * Which engine transcribes the mic.
 *
 * JARVIS_STT_PROVIDER wins when set (groq | elevenlabs); otherwise Groq's
 * Whisper when its key is present — free and far more generous than the
 * free Scribe allowance — else ElevenLabs Scribe, else no transcriber at
 * all: /stt reports 503 and the browser's own recogniser takes over
 * (capabilities.ts reads this choice out of /health).
 */
function sttProvider() {
  const want = (process.env.JARVIS_STT_PROVIDER ?? '').trim().toLowerCase()
  if (want === 'groq') return process.env.GROQ_API_KEY ? 'groq' : null
  if (want === 'elevenlabs' || want === 'eleven') return elevenKey() ? 'elevenlabs' : null
  if (process.env.GROQ_API_KEY) return 'groq'
  if (elevenKey()) return 'elevenlabs'
  return null
}

/**
 * Where /file is permitted to read from, and how big a read may get.
 *
 * The roots are realpath'd once at boot so the containment check below compares
 * like with like — on macOS os.tmpdir() is a symlink into /private/var, and a
 * string prefix test against the unresolved form would reject every screenshot.
 */
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  // .svg is deliberately absent. An SVG is a scriptable document, and this
  // endpoint serves it from the bridge's own origin — the one origin allowed
  // to open the agent socket. A picture is not worth that.
}

const MAX_FILE_BYTES = 25 * 1024 * 1024

const FILE_ROOTS = [
  homedir(),
  // Both temp directories, because on macOS os.tmpdir() is the per-user
  // $TMPDIR under /var/folders while half the tools that take a screenshot
  // still write it to /tmp. Dropping one of them loses real panels.
  tmpdir(),
  '/tmp',
  ...(process.env.JARVIS_FILE_ROOTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
].map((root) => {
  try {
    return realpathSync(root)
  } catch {
    return resolvePath(root)
  }
})

/** True when `real` sits inside one of the roots, after both are resolved. */
const withinRoots = (real) =>
  FILE_ROOTS.some((root) => {
    const rel = relative(root, real)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  })

// ---------------------------------------------------------------------------

/**
 * Remote media, fetched by the bridge instead of by the page.
 *
 * JARVIS used to refuse to show anything he found on the web, and the refusal
 * was not squeamishness — a bare <img src="https://some-cdn/..."> in a panel
 * genuinely did not work. Three reasons, and all three are fixed by moving the
 * fetch to this side of the wire:
 *
 *   1. Hotlink blocking. News sites and image CDNs check Referer and User-Agent
 *      and hand a browser-that-isn't-their-page a 403 or a placeholder. That is
 *      why thumbnails rendered as empty rectangles. A server-side fetch that
 *      looks like an ordinary browser and sends no referrer gets the bytes.
 *   2. Privacy. Panel HTML is authored by a model that has just been reading
 *      untrusted web pages, so a remote URL in it is a prompt-injection beacon:
 *      load it directly and the user's IP, and the fact they asked, go to a host
 *      the page chose. Proxying means the browser only ever talks to localhost
 *      and the page CSP can stay tight.
 *   3. One place to cap size, set timeouts and insist the bytes really are the
 *      media type they claim.
 *
 * The cost is that this process — unlike a browser tab — can reach the user's
 * LAN, their router's admin page, and cloud metadata endpoints. So everything
 * below is an SSRF gate first and a proxy second.
 */

const MAX_IMG_BYTES = 15 * 1024 * 1024
const MAX_MEDIA_BYTES = 200 * 1024 * 1024
const IMG_TIMEOUT_MS = 10_000
const MEDIA_TIMEOUT_MS = 30_000

/**
 * The shared body of /img and /media.
 *
 * `kinds` is the list of content-type prefixes we are willing to hand back.
 * That check is load-bearing: without it this is an open proxy that will serve
 * an attacker's HTML from the bridge's own origin — the one origin allowed
 * to open the agent socket — which is the same reason IMAGE_TYPES has no .svg.
 */
async function proxyRemote(req, res, cors, { kinds, maxBytes, timeoutMs, ranged }) {
  const asked = new URL(req.url, 'http://x').searchParams.get('url') ?? ''
  const target = vetTarget(asked)

  const headers = {
    'user-agent': PROXY_UA,
    accept: ranged ? '*/*' : 'image/*,*/*;q=0.8',
    // Identity encoding so the byte cap counts the bytes we actually stream and
    // content-length means what it says. Media is already compressed anyway.
    'accept-encoding': 'identity',
  }
  // Range is the difference between a <video> that seeks and one Safari refuses
  // to play at all, so the browser's request is passed through verbatim.
  if (ranged && typeof req.headers.range === 'string') {
    headers.range = req.headers.range
  }

  const { res: upstream } = await openRemote(target, headers, timeoutMs)
  const status = upstream.statusCode ?? 0

  if (status !== 200 && status !== 206) {
    upstream.resume()
    throw proxyError(status === 404 ? 404 : 502, `upstream said ${status}`)
  }

  const type = String(upstream.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (!kinds.some((kind) => type.startsWith(kind))) {
    upstream.resume()
    throw proxyError(415, `not ${kinds.join(' or ')} (got ${type || 'nothing'})`)
  }

  const declared = Number(upstream.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    upstream.resume()
    throw proxyError(413, 'too large')
  }

  const out = {
    ...cors,
    'content-type': type,
    'x-content-type-options': 'nosniff',
    // Thumbnails get looked at, panelled again, and re-rendered on every HUD
    // repaint; re-fetching from the CDN each time is slow and rude.
    'cache-control': 'private, max-age=600',
  }
  if (Number.isFinite(declared)) out['content-length'] = String(declared)
  if (ranged) {
    if (status === 206 || upstream.headers['accept-ranges'] === 'bytes') {
      out['accept-ranges'] = 'bytes'
    }
    if (upstream.headers['content-range']) {
      out['content-range'] = upstream.headers['content-range']
    }
  }
  res.writeHead(status, out)

  // Stream with a running cap. Buffering a 200 MB video into this process
  // would stall the token stream the voice is riding on, and trusting
  // content-length would let a host that lies about it eat the heap.
  let sent = 0
  upstream.on('data', (chunk) => {
    sent += chunk.length
    if (sent > maxBytes) {
      console.warn(`[trinity] proxy cut ${target.href} at ${maxBytes} bytes`)
      upstream.destroy()
      res.destroy()
      return
    }
    if (!res.write(chunk)) {
      upstream.pause()
      res.once('drain', () => upstream.resume())
    }
  })
  upstream.on('end', () => res.end())
  upstream.on('error', () => res.destroy())
  req.on('close', () => upstream.destroy())
}

// ---------------------------------------------------------------------------

/**
 * CORS, reflected rather than wildcarded.
 *
 * `*` on this origin means any page on the internet can read whatever the
 * bridge serves, so the same allowlist that guards the socket picks the
 * header. A request carrying an Origin we don't know is refused outright —
 * but a request with no Origin at all is served, because an <img src> load
 * (which is how panels fetch screenshots) never sends one.
 */
function corsFor(req) {
  const origin = req.headers.origin
  const headers = { vary: 'origin' }
  if (origin) {
    headers['access-control-allow-origin'] = origin
    headers['access-control-allow-headers'] = 'content-type'
  }
  return headers
}

// One HTTP server for both the speech proxy and the WebSocket upgrade.
const http = await import('node:http')

const handleRequest = async (req, res) => {
  const origin = req.headers.origin
  if (origin && !originAllowed(origin)) {
    console.warn(`[trinity] refused http request from origin ${origin}`)
    res.writeHead(403, { vary: 'origin' })
    return res.end('forbidden')
  }
  const cors = corsFor(req)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    return res.end()
  }

  if (req.method === 'GET' && req.url === '/health') {
    // The browser reads this once at boot to decide which voice engine to use.
    // `tts` means "some cloud voice is reachable"; `voice` names which one, so
    // the HUD labels the engine truthfully when Fish Audio is configured.
    // `stt` is whether some cloud transcriber exists (Groq Whisper or Scribe;
    // Fish is speaker-out) and `sttEngine` names which, so the browser never
    // credits the wrong service. Without a key the app falls back to the
    // browser's own recogniser and voice, so a student with nothing configured
    // still has a working assistant.
    const provider = ttsProvider()
    const stt = sttProvider()
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(
      JSON.stringify({ ok: true, tts: Boolean(provider), stt: Boolean(stt), sttEngine: stt, voice: provider }),
    )
  }

  // Serve local image files to the page. Screenshots and generated art land on
  // disk as absolute paths, and a page served over http can't read file:// —
  // so the bridge, which can, hands them over.
  if (req.method === 'GET' && req.url?.startsWith('/file?')) {
    const asked = new URL(req.url, 'http://x').searchParams.get('path') ?? ''
    // Resolve symlinks BEFORE judging anything. A name ending in .png can be a
    // link pointing at /etc/hosts, and checking the suffix the caller supplied
    // would wave that straight through — which is exactly how this endpoint
    // used to serve the contents of arbitrary system files.
    let real = null
    try {
      if (isAbsolute(asked)) real = await realpath(asked)
    } catch {
      real = null
    }
    const dot = real ? real.lastIndexOf('.') : -1
    const ext = dot === -1 ? '' : real.slice(dot).toLowerCase()
    // Images only, absolute paths only, and only under roots we expect things
    // to be written to. This endpoint exists to show pictures, not to be a
    // general file read for whatever the model — or another page — asks for.
    if (!real || !Object.hasOwn(IMAGE_TYPES, ext) || !withinRoots(real)) {
      res.writeHead(400, cors)
      return res.end('images only')
    }
    try {
      const info = await stat(real)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        res.writeHead(413, cors)
        return res.end('too large')
      }
      // Asynchronous because this process is also pumping the model's token
      // stream; a synchronous read of a large screenshot stalls the voice.
      const body = await readFile(real)
      res.writeHead(200, {
        ...cors,
        'content-type': IMAGE_TYPES[ext],
        'x-content-type-options': 'nosniff',
      })
      return res.end(body)
    } catch {
      res.writeHead(404, cors)
      return res.end('not found')
    }
  }

  // Remote images, fetched here so the page never talks to the wider web. The
  // renderer rewrites every http(s) <img src> in a panel to this endpoint.
  if (req.method === 'GET' && req.url?.startsWith('/img?')) {
    try {
      await proxyRemote(req, res, cors, {
        kinds: ['image/'],
        maxBytes: MAX_IMG_BYTES,
        timeoutMs: IMG_TIMEOUT_MS,
        ranged: false,
      })
    } catch (err) {
      if (res.headersSent) return res.destroy()
      res.writeHead(err.status ?? 502, cors)
      return res.end(err.message ?? 'proxy failed')
    }
    return
  }

  // The same, for video and audio. Separate from /img because the limits and
  // the Range handling are genuinely different, not because the code is.
  if (req.method === 'GET' && req.url?.startsWith('/media?')) {
    try {
      await proxyRemote(req, res, cors, {
        kinds: ['video/', 'audio/'],
        maxBytes: MAX_MEDIA_BYTES,
        timeoutMs: MEDIA_TIMEOUT_MS,
        ranged: true,
      })
    } catch (err) {
      if (res.headersSent) return res.destroy()
      res.writeHead(err.status ?? 502, cors)
      return res.end(err.message ?? 'proxy failed')
    }
    return
  }

  // A whole web page, fetched here and served from this origin so it can be
  // framed. The publisher's X-Frame-Options and CORS rules are enforced against
  // the browser, and from the browser's point of view this document is ours —
  // so an article that refuses to be embedded anywhere still opens on the
  // display. See page.mjs for what each mode does to the markup.
  if (req.method === 'GET' && req.url?.startsWith('/page?')) {
    const asked = new URL(req.url, 'http://x')
    const target = asked.searchParams.get('url') ?? ''
    const mode = asked.searchParams.get('mode') === 'live' ? 'live' : 'reader'
    try {
      const page = await renderPage(target, mode, `http://localhost:${PORT}`)
      res.writeHead(200, { ...cors, ...page.headers })
      return res.end(page.body)
    } catch (err) {
      // Rendered as a page rather than returned as a status, because this lands
      // inside an iframe: a bare 502 body is a blank rectangle on the display,
      // which reads as the interface being broken rather than as the article
      // being unavailable.
      res.writeHead(err.status ?? 502, {
        ...cors,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      })
      return res.end(
        `<!doctype html><meta charset="utf-8"><style>
           body{margin:0;padding:26px;background:transparent;color:#7fb6bf;
                font:400 13px/1.6 ui-monospace,monospace}
           b{color:#cfe9ee;font-weight:500;display:block;margin-bottom:6px}
         </style><b>This page could not be opened.</b>${
           String(err?.message ?? 'unknown error').replace(/[<&]/g, '')
         }`,
      )
    }
  }

  if (req.method === 'POST' && req.url === '/tts') {
    const provider = ttsProvider()
    if (!provider) {
      res.writeHead(503, cors)
      return res.end('no tts provider — set FISH_API_KEY + FISH_VOICE_ID, or ELEVENLABS_API_KEY')
    }
    // A spoken line is a few hundred bytes. Anything approaching this is not a
    // sentence, and buffering it unbounded would let one request eat the heap.
    let body = ''
    let overflowed = false
    for await (const chunk of req) {
      body += chunk
      if (body.length > 64 * 1024) {
        overflowed = true
        break
      }
    }
    if (overflowed) {
      req.destroy()
      res.writeHead(400, cors)
      return res.end('body too large')
    }
    let text
    try {
      ;({ text } = JSON.parse(body || '{}'))
    } catch {
      res.writeHead(400, cors)
      return res.end('bad json')
    }
    if (!text) {
      res.writeHead(400, cors)
      return res.end('no text')
    }
    try {
      const upstream =
        provider === 'fish'
          ? await fetch('https://api.fish.audio/v1/tts', {
              method: 'POST',
              headers: {
                authorization: `Bearer ${fishKey()}`,
                'content-type': 'application/json',
                // The model is a HEADER on Fish's API, not a body field — and
                // an unrecognized value silently falls back to paid s2.1-pro,
                // which is why the free tier is pinned explicitly here.
                model: FISH_MODEL,
              },
              body: JSON.stringify({
                text,
                reference_id: fishVoiceId(),
                format: 'mp3',
                // Speech over a laptop speaker: 64kbps mono is half the bytes
                // of the default 128 and indistinguishable at this distance.
                mp3_bitrate: 64,
                latency: FISH_LATENCY,
                normalize: true, // normalizes numbers/English — steadier reads
              }),
            })
          : await fetch(
              `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream` +
                // 22kHz mono is half the bytes of 44kHz and indistinguishable
                // through a laptop speaker; optimize_streaming_latency=3 trades
                // a little prosody for a much earlier first byte.
                `?output_format=mp3_22050_32&optimize_streaming_latency=3`,
              {
                method: 'POST',
                headers: { 'xi-api-key': elevenKey(), 'content-type': 'application/json' },
                body: JSON.stringify({
                  text,
                  // Flash is the low-latency model — a conversation needs speed
                  // more than it needs the last few percent of quality.
                  model_id: 'eleven_flash_v2_5',
                  voice_settings: {
                    stability: 0.4,
                    similarity_boost: 0.75,
                    speed: 1.05,
                  },
                }),
              },
            )
      if (!upstream.ok) {
        res.writeHead(upstream.status, cors)
        return res.end(await upstream.text())
      }

      // Pipe it through rather than buffering. Waiting for the whole file here
      // would throw away everything the streaming endpoint just bought us.
      res.writeHead(200, {
        ...cors,
        'content-type': 'audio/mpeg',
        'cache-control': 'no-cache',
      })
      for await (const chunk of upstream.body) res.write(Buffer.from(chunk))
      return res.end()
    } catch (err) {
      res.writeHead(502, cors)
      return res.end(String(err?.message ?? err))
    }
  }

  // Speech to text. The browser captures one spoken segment as a compressed
  // audio blob and posts the raw bytes here; the bridge hands them to whichever
  // transcriber it has a key for (Groq Whisper, else ElevenLabs Scribe) and
  // returns the transcript. Detecting that the user is speaking at all is done
  // locally with voice-activity detection, which never touches this endpoint;
  // this is only for the words.
  if (req.method === 'POST' && req.url === '/stt') {
    const stt = sttProvider()
    if (!stt) {
      res.writeHead(503, cors)
      return res.end('no stt provider — set GROQ_API_KEY or ELEVENLABS_API_KEY')
    }

    const type = req.headers['content-type'] || 'audio/webm'
    const chunks = []
    let size = 0
    let overflowed = false
    // A few seconds of Opus is well under a megabyte; 25 MB is a generous
    // ceiling that still refuses a runaway stream before it eats the heap.
    for await (const chunk of req) {
      chunks.push(chunk)
      size += chunk.length
      if (size > 25 * 1024 * 1024) {
        overflowed = true
        break
      }
    }
    if (overflowed) {
      req.destroy()
      res.writeHead(413, cors)
      return res.end('audio too large')
    }
    // Silence, or a click. Nothing to transcribe, and calling out to the API
    // for it would only add latency to a non-answer.
    if (size < 1200) {
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: '' }))
    }

    try {
      // The filename extension is the only hint a transcriber gets about the
      // codec, so derive it from the content-type the MediaRecorder reported
      // rather than hard-coding one.
      const ext = type.includes('ogg')
        ? 'ogg'
        : type.includes('mp4') || type.includes('mpeg')
          ? 'mp4'
          : type.includes('wav')
            ? 'wav'
            : 'webm'
      const audio = Buffer.concat(chunks)

      if (stt === 'elevenlabs') {
        const form = new FormData()
        form.append('model_id', 'scribe_v1')
        form.append('file', new Blob([audio], { type }), `speech.${ext}`)

        const upstream = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
          method: 'POST',
          headers: { 'xi-api-key': elevenKey() },
          body: form,
        })
        if (!upstream.ok) {
          res.writeHead(upstream.status, cors)
          return res.end(await upstream.text())
        }
        const data = await upstream.json()
        res.writeHead(200, { ...cors, 'content-type': 'application/json' })
        return res.end(JSON.stringify({ text: (data.text ?? '').trim() }))
      }

      // Groq's OpenAI-compatible transcription endpoint: audio in, { text } out
      // — the same contract the browser sees either way, which is exactly why
      // /health reports the engine's name separately.
      const form = new FormData()
      form.append('file', new Blob([audio], { type }), `speech.${ext}`)
      form.append('model', process.env.JARVIS_STT_MODEL ?? 'whisper-large-v3-turbo')

      const upstream = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}` },
        body: form,
      })
      if (!upstream.ok) {
        res.writeHead(upstream.status, cors)
        return res.end(await upstream.text())
      }
      const data = await upstream.json()
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: (data.text ?? '').trim() }))
    } catch (err) {
      res.writeHead(502, cors)
      return res.end(String(err?.message ?? err))
    }
  }

  res.writeHead(404, cors)
  res.end()
}

const server = http.createServer((req, res) => {
  // The handler is async, so anything it throws would otherwise become an
  // unhandled rejection and leave the browser waiting on a socket that is
  // never going to answer.
  handleRequest(req, res).catch((err) => {
    console.error('[trinity] request failed:', err)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})

const wss = new WebSocketServer({
  server,
  // The handshake is the only place a page can be turned away, so it happens
  // here rather than after the socket is open. Rejections are logged loudly:
  // the likeliest cause is a dev server on an unexpected port, and a silent
  // 403 would look like the bridge simply isn't running.
  verifyClient: ({ origin, req }, done) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path !== '/' && path !== '/ws') {
      console.warn(`[trinity] rejected websocket on path ${path}`)
      return done(false, 403, 'Forbidden')
    }
    if (!originAllowed(origin)) {
      console.warn(
        `[trinity] rejected websocket from origin ${origin ?? '(none)'}` +
          ' — set JARVIS_ALLOWED_ORIGINS to permit it',
      )
      return done(false, 403, 'Forbidden')
    }
    done(true)
  },
})
server.listen(PORT)

console.log(`[trinity] bridge listening on ws://localhost:${PORT}`)
console.log(
  `[trinity] speech in: ${
    sttProvider() === 'groq' ? 'Groq Whisper' : sttProvider() === 'elevenlabs' ? 'ElevenLabs Scribe' : 'browser recogniser'
  } · out: ${ttsProvider() ?? 'browser voice'}`,
)
console.log(
  `[trinity] writes ${ALLOW_WRITES ? 'ENABLED' : 'disabled'}` +
    (ALLOW_WRITES ? '' : ' — set JARVIS_ALLOW_WRITES=1 to permit shell/file/device actions'),
)
// Asynchronous, so it lands a beat after the rest of the banner.
void chromeAvailable().then((ok) => {
  console.log(
    ok
      ? `[trinity] browser control ready${ALLOW_WRITES ? '' : ' (reading only — clicking and typing need JARVIS_ALLOW_WRITES=1)'}`
      : '[trinity] browser control unavailable — no Chrome extension socket found (fine; web_search/fetch_page still work)',
  )
})

console.log(
  '[trinity] accepting local dev origins' +
    (EXTRA_ORIGINS.size ? ` plus ${[...EXTRA_ORIGINS].join(', ')}` : '') +
    (ALLOW_NO_ORIGIN ? ' and clients that send no origin' : ''),
)

// Providers, probed once for the banner. A missing key is a warning, not a
// crash — one provider configured is a working assistant; none is an error the
// user needs to see spelled out.
void probeProviders().then((status) => {
  for (const [name, s] of Object.entries(status)) {
    if (!s.configured) {
      console.warn(`[trinity] ${name}: no API key — set ${name === 'groq' ? 'GROQ_API_KEY' : 'NVIDIA_API_KEY'} to enable it`)
      continue
    }
    if (!s.ok) {
      console.warn(`[trinity] ${name}: key present but the catalog was unreachable; using "${s.model}" as-is`)
      continue
    }
    console.log(`[trinity] ${name}: ${s.models} models · brain "${s.resolvedModel ?? s.model}"`)
  }
})

// ---------------------------------------------------------------------------
// The agent loop
// ---------------------------------------------------------------------------

/**
 * History is kept per connection, bounded. A voice conversation does not need
 * everything forever, and both free tiers meter tokens — so older exchanges
 * fall off the front once the cap is hit, keeping the system prompt's share of
 * the context small.
 */
const HISTORY_CAP = 24 // messages (12 exchanges)

/**
 * The full turn: messages in, streamed answer out, tools executed under the
 * gate on the way. This is the loop the SDK used to hide.
 *
 * Routing policy (the "traffic controller"):
 *   - a turn starts on the fast provider;
 *   - the moment a reply carries tool_calls, the rest of the turn runs on the
 *     smart provider — chitchat never pays the smart tier's latency, and the
 *     smart tier only wakes up when there is real work;
 *   - llm.complete escalates to the other provider on 429/timeout/5xx either
 *     way, so a rate limit bends the turn instead of breaking it.
 *
 * @param {object} o
 * @param {string} o.userText
 * @param {Array} o.history - mutable; previous messages, pushed-to by this turn
 * @param {object} o.registry - the tool registry
 * @param {(delta: string) => void} o.onDelta - streamed speech
 * @param {(name: string) => void} o.onTool - a tool that actually ran
 * @param {() => boolean} o.aborted - barge-in check
 * @param {AbortController} o.ac
 */
async function runTurn({ userText, history, registry, onDelta, onTool, aborted, ac }) {
  const usedTools = []
  history.push({ role: 'user', content: userText })

  let route = initialRoute()
  let finalText = ''

  for (let step = 0; step < MAX_STEPS; step++) {
    if (aborted()) return { text: finalText, tools: usedTools }

    // Promote to the smart tier once tool work has begun: the conversation
    // half of the turn stays fast, the working half gets the bigger brain.
    if (usedTools.length && route !== promoteRoute()) route = promoteRoute()

    const out = await complete({
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
      tools: registry.schemas,
      route,
      signal: ac.signal,
      onDelta: (d) => {
        finalText += d
        onDelta(d)
      },
    })

    if (aborted()) return { text: finalText, tools: usedTools }

    // The one truncation that is not an error: finish_reason 'length' means
    // the reply ran into JARVIS_MAX_TOKENS mid-sentence — and every word of
    // that cut sentence gets spoken. Name it in the log when it happens.
    if (out.finishReason === 'length') {
      console.warn('[trinity] reply hit JARVIS_MAX_TOKENS mid-sentence — raise it in .env.local if this repeats')
    }

    // A reply with no tool calls ends the turn. The streamed deltas already
    // spoke it; the return value feeds history.
    if (!out.toolCalls.length) {
      history.push({ role: 'assistant', content: out.content })
      trim(history)
      return { text: finalText, tools: usedTools }
    }

    // Record the assistant's tool-call message in the exact wire shape the
    // OpenAI-compatible providers expect — tool_calls on the assistant entry,
    // one role:'tool' entry per result, joined by tool_call_id.
    history.push({
      role: 'assistant',
      content: out.content || null,
      tool_calls: out.toolCalls,
    })

    for (const tc of out.toolCalls) {
      if (aborted()) {
        // Barge-in mid-loop. Every tool_call already on record must get a
        // result — a dangling tool_call makes the NEXT turn's request a 400 on
        // most providers, which is a bug that would only show on the turn
        // after the one the user interrupted.
        for (const pending of out.toolCalls) {
          if (history.some((m) => m.role === 'tool' && m.tool_call_id === pending.id)) continue
          history.push({ role: 'tool', tool_call_id: pending.id, content: 'Interrupted.' })
        }
        return { text: finalText, tools: usedTools }
      }
      const name = tc.function.name
      let args = {}
      try {
        args = JSON.parse(tc.function.arguments || '{}')
      } catch {
        // A malformed argument string is a tool result, not a crashed turn.
        args = {}
      }

      const allowed = decideTool(name)
      console.log(`[trinity] tool ${name} -> ${allowed ? 'allow' : 'deny'}`)
      if (!allowed) {
        // Worded so the model can pass it on as one plain sentence. Every word
        // of this can end up spoken.
        history.push({
          role: 'tool',
          tool_call_id: tc.id,
          content:
            'Blocked: this assistant is running in read-only mode and cannot ' +
            'take actions that change anything. Tell the user this action is ' +
            'unavailable until they enable write access on the machine.',
        })
        continue
      }

      onTool(name)
      const result = await registry.call(name, args)
      const text = (result.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
      history.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: text || (result.isError ? 'The tool failed.' : 'Done.'),
      })
      usedTools.push(name)
    }
  }

  // The step ceiling hit while the model still wanted tools. Close the turn
  // honestly rather than silently — one sentence, in persona.
  const line = 'That is taking longer than it should, sir. Ask me again.'
  onDelta(line)
  history.push({ role: 'assistant', content: line })
  trim(history)
  return { text: finalText, tools: usedTools }
}

/** Drop from the front until under the cap AND the history starts on a user
 *  message — so no tool result is ever orphaned from its tool_call, and no
 *  provider ever sees a conversation that begins mid-exchange. */
function trim(history) {
  while (history.length > HISTORY_CAP || (history.length && history[0].role === 'tool')) {
    history.shift()
  }
}

/**
 * What to tell the browser when a turn fails. Plain sentences, because
 * whatever reaches the client is liable to be spoken.
 */
const TURN_FAILURES = {
  quota: 'Both providers have turned me away for now. Ask me again shortly.',
  default: 'The turn failed part way through.',
}

wss.on('connection', (socket) => {
  console.log('[trinity] client connected')

  // Announce the tool families straight away rather than making the HUD wait.
  // Refined below once MCP servers (if any) have reported in.
  const registry = createRegistry({
    allowWrites: ALLOW_WRITES,
    ask: (kind, args, timeoutMs) => askBrowser(kind, args, timeoutMs),
    emitBlade: (blade) => send({ type: 'blade', blade }),
    emitUi: (op, args) => send({ type: 'ui', op, args }),
  })
  socket.send(JSON.stringify({ type: 'ready', servers: registry.serverNames }))

  // MCP servers start out of band; their tools join the registry when they
  // arrive, and the HUD gets the updated rail.
  void loadMcpTools({ allowWrites: ALLOW_WRITES }).then(({ tools, serverNames }) => {
    if (!tools.length) return
    registry.add(tools)
    send({ type: 'ready', servers: registry.serverNames })
    console.log(`[trinity] ${serverNames.length} MCP server(s) available`)
  })

  const send = (msg) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
  }

  /**
   * Which question the agent is currently answering.
   *
   * The stream carries no notion of a turn, so without this the client cannot
   * tell the tail of an abandoned answer from the start of the new one — it
   * attaches a listener and receives whatever is on the socket. Echoing the
   * id the client sent lets it ignore anything that is not its own.
   */
  let answering = null
  const sendTurn = (msg) => send({ ...msg, ask: answering })

  /**
   * Asking the browser for something and waiting for the answer. The camera
   * is the only tool that needs it — the hardware is over there and the model
   * is here, so a frame has to come back.
   */
  const waiting = new Map()
  let asks = 0

  const askBrowser = (kind, args, timeoutMs = 20_000) =>
    new Promise((resolve, reject) => {
      if (socket.readyState !== socket.OPEN) {
        return reject(new Error('the interface is not connected'))
      }
      const id = `q${++asks}`
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error('the interface did not answer in time'))
      }, timeoutMs)
      waiting.set(id, { resolve, timer })
      send({ type: kind, id, ...args })
    })

  /** The AbortController for the turn in flight — barge-in pulls it. */
  let activeAc = null

  /** One conversation per connection, one turn at a time. The socket IS the
   *  session, as before; the queue is what keeps a second question from
   *  running concurrently with an unfinished first. */
  const history = []
  let queue = Promise.resolve()

  const runOneAsk = (text, id) => {
    answering = id
    const ac = new AbortController()
    activeAc = ac
    return (async () => {
      try {
        const { text: final } = await runTurn({
          userText: text,
          history,
          registry,
          onDelta: (d) => sendTurn({ type: 'text', delta: d }),
          onTool: (name) => sendTurn({ type: 'tool', name }),
          aborted: () => ac.signal.aborted,
          ac,
        })
        sendTurn({ type: 'done', text: final })
      } catch (err) {
        if (ac.signal.aborted) {
          // A barge-in, not a failure: the caller has already settled its
          // promise locally. Close the turn quietly with what was said.
          sendTurn({ type: 'done', text: '' })
        } else {
          console.error('[trinity] turn failed:', err?.message ?? err)
          const quota =
            err?.status === 429 || /quota|rate.?limit/i.test(String(err?.message ?? ''))
          sendTurn({
            type: 'error',
            message: quota ? TURN_FAILURES.quota : String(err?.message ?? TURN_FAILURES.default),
          })
        }
      } finally {
        activeAc = null
      }
    })()
  }

  socket.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (msg.type === 'ask' && typeof msg.text === 'string') {
      const text = msg.text
      const id = typeof msg.id === 'string' ? msg.id : null
      // Queued behind whatever is still running. The reference client always
      // interrupts before superseding a question, so in practice this queue is
      // empty — but a client that fires two asks without interrupting gets
      // serialised turns rather than interleaved ones.
      queue = queue.then(() => runOneAsk(text, id)).catch(() => {})
    }

    if (msg.type === 'reply' && typeof msg.id === 'string') {
      const slot = waiting.get(msg.id)
      if (slot) {
        waiting.delete(msg.id)
        clearTimeout(slot.timer)
        slot.resolve(msg)
      }
    }

    if (msg.type === 'interrupt') {
      // Stop the tokens now; the queue's next entry starts once this turn has
      // actually finished winding down, which is quick — the abort is checked
      // between every streamed chunk and before every tool call.
      activeAc?.abort()
    }
  })

  socket.on('close', () => {
    console.log('[trinity] client disconnected')
    activeAc?.abort()
  })
})
