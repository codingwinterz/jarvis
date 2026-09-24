# EDITH

A browser voice assistant with an Iron Man holographic interface. Say
**"Edith"**, he wakes, listens, and does real things through his tools —
searches the web, reads pages, drives your browser, looks through your camera.
The face is a web page (React + Vite + Three.js + custom GLSL). The brain is a
hand-rolled agent loop over **free OpenAI-compatible providers** — no
subscription, no API bill.

**What it costs: nothing.** Two free API keys power it:

| Provider | Key from | Role |
|---|---|---|
| **Groq** | console.groq.com (free, no card) | The fast tier — conversation answered at LPU speed |
| **NVIDIA** | build.nvidia.com (free developer key) | The smart tier — Nemotron 3 takes the tool-heavy turns |

Configure one and that provider does everything. Configure both and the
**hybrid router** gets the best of each: every turn starts on Groq, and the
moment the reply asks for tools, the rest of the turn is promoted to Nemotron.
Either provider catching the other's rate limit bends the turn instead of
breaking it. **ElevenLabs is an optional add-on** for a better voice and
sharper hearing; without it everything runs on the browser's own speech.

---

## Requirements

**In one line:** two free API keys, plus two free things every computer can
have — Node.js and Chrome.

- **Node.js 20 or newer** — free, one installer from <https://nodejs.org>.
- **A free Groq key** — <https://console.groq.com> → API Keys. The fast tier.
- **A free NVIDIA key** — <https://build.nvidia.com> → sign in → Get API Key.
  The smart tier (Nemotron 3).
- **Google Chrome or Microsoft Edge**, in a **real browser window** — not an
  embedded preview pane. Preview panes block microphone access, so the page
  loads and looks right but never hears you. EDITH also needs WebGL.
- **Optional: an ElevenLabs API key** — a better voice and sharper hearing.
  The free tier is plenty for a demo.

Run `npm run setup` after cloning and it checks all of this for you, in plain
language, including a live probe of both provider keys.

---

## Quick start

```bash
npm install
cp .env.example .env.local    # add GROQ_API_KEY / NVIDIA_API_KEY
npm start                     # runs the brain and the face together
```

Then open the URL it prints (http://localhost:5173) in **Chrome**, click
**INITIALISE**, and say **"Edith"**.

Prefer two terminals? Run them separately instead:

```bash
npm install
```

Terminal 1 — the brain:

```bash
npm run bridge
```

Terminal 2 — the face:

```bash
npm run dev
```

### Starting with Windows

To have EDITH come up by itself at every sign-in — brain, face and the
window — install the startup launcher once:

```bash
npm run boot:install
```

From then on, logging in starts the stack (hidden, logging to `logs/boot.log`)
and opens the interface as a **standalone app window** — no tabs, no address
bar, like a desktop program. It still runs on Chrome/Edge underneath, which is
what the microphone and speech permissions are tied to. If the stack is already
running, the launcher just reopens the window — it never starts a second copy.

```bash
npm run boot:stop      # end the running session
npm run boot:remove     # stop starting at sign-in
```

Then open the app in a **real Chrome or Edge window**, click **INITIALISE**,
allow the microphone when asked, and say **"Edith"**.

> It has to be a real browser window. Embedded preview panes block the
> microphone, so EDITH will look perfectly alive and simply never respond.

---

## How it works

EDITH is two processes. The browser is the face and the voice; the bridge is
the brain and the hands.

```
┌─ browser (the face) ───────────────┐  ┌─ bridge (the brain) ──────────────┐
│ "Edith" wake word             │  │ Node · bridge/server.mjs          │
│ local VAD → speech to text         │  │ own agent loop (no vendor SDK)    │
│ reactor UI (Three.js + GLSL)       │◄─┼─►│ Groq ── fast tier (LPU)       │
│ text to speech                     │  │ NVIDIA ─ smart tier (Nemotron)  │
│ heads-up display                   │  │ tool registry + permission gate   │
└────────────────────────────────────┘  │ MCP servers (edith.mcp.json)     │
                                        └───────────────────────────────────┘
```

Everything you see and hear happens in the browser. The bridge is a single
Node process (`bridge/server.mjs`) that runs the agent loop: thread the
history, stream the reply, execute tool calls under the permission gate, feed
results back, until the model answers in plain words. They talk over a
WebSocket (plus a few HTTP endpoints) on `ws://localhost:8787`.

**Why a bridge at all?** A browser tab cannot run local tool processes —
Chrome control, stdio MCP servers, file access. The bridge can. And keeping
the provider keys in the bridge (never in the page) means the browser bundle
carries no secrets in the default mode.

**The models.** Defaults resolve against each provider's own catalogue at
boot, so retired slugs self-heal and the best Nemotron 3 variant is picked
automatically. Override with `JARVIS_GROQ_MODEL` / `JARVIS_NEMOTRON_MODEL`.

### The hybrid router

`bridge/llm.mjs` implements the traffic controller:

- Every turn **starts on Groq** — chitchat is answered in a heartbeat.
- A reply containing tool calls **promotes the turn to Nemotron** — real
  agentic work gets the bigger brain, and the turn stays there until it ends.
- On **429 / timeout / 5xx / context-overflow**, the request escalates to the
  other provider, with one backed-off retry. Quota exhaustion on both tiers
  surfaces as one plain spoken sentence, not a stack trace.

Force one brain with `JARVIS_ROUTING=groq` or `JARVIS_ROUTING=nemotron`;
invert the promotion with `JARVIS_ROUTE=smart-first`.

### The voice pipeline

Unchanged from the original design, and provider-agnostic:

- **Detection is local.** An energy-based voice-activity detector
  (`src/lib/vad.ts`) decides when you are speaking. It is instant, cannot
  quietly fail, and is what makes **barge-in** work — speak while EDITH is
  talking and he stops.
- **Transcription has two tiers, chosen automatically at boot.** The browser
  asks the bridge `/health` and picks the best available: the bridge's cloud
  transcriber — Groq Whisper on a `GROQ_API_KEY`, else ElevenLabs Scribe —
  otherwise the browser's own `SpeechRecognition`, guarded by a heartbeat so
  it recovers when Chrome throttles it.
- **Speaking** uses the Fish Audio voice when configured, the ElevenLabs voice
  when a key is present, and the browser's `speechSynthesis` otherwise.
  Capability detection lives in
  `src/lib/capabilities.ts` (probing `GET /health` once at boot).

---

## What EDITH can do

### Built-in tools (no keys beyond the providers)

- **`web_search`** — DuckDuckGo results, parsed and ranked. No search-API key.
- **`fetch_page`** — fetches a page and returns its actual text, through the
  bridge's SSRF-guarded outbound client.

### The interface is his

- `display` — authors a panel (or blade) in a fixed `.hud-*` design system;
  the browser sanitises the markup (DOMPurify, class allowlist, strict CSP)
  before rendering. Images, video and YouTube/Vimeo embeds work; remote media
  is fetched **server-side** through the bridge (`/img`, `/media`,
  SSRF-guarded) so hotlink-blocked thumbnails still appear.
- `ui_theme` · `ui_reactor` · `ui_orbit` · `ui_chrome` · `ui_effect` ·
  `ui_screen` · `ui_reset` — retint, reshape, orbit, strip, flourish, clear,
  restore. *"Make it red and hide the systems list"* is a spoken command.
- `blade` · `probe_url` — the big surface for reading, and the way to check
  what a URL really is before showing it.

### Your browser and your camera

- **`chrome_*`** — drives your own Chrome through the Claude for Chrome
  extension's local socket: read pages, navigate, screenshot; and with writes
  enabled, click, type and fill forms. Reading is always allowed; acting waits
  for `JARVIS_ALLOW_WRITES=1`.
- **`look` / `watch`** — one frame or a stamped grid of frames from your
  camera, described by a vision-capable model on the same provider keys.
  Nothing is stored; the description is all that comes back.

### MCP servers — the extensible tool ecosystem

Community tools plug in via `bridge/edith.mcp.json`:

```json
{
  "servers": {
    "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] },
    "notion":     { "url": "https://mcp.notion.com/mcp", "token": "…" }
  }
}
```

Both stdio and Streamable-HTTP servers are supported. Discovered tools
register as `mcp__<server>__<tool>` and pass through the same permission gate
as every other tool.

#### Gmail & GitHub — wired in, disabled until you add secrets

Ready-made `url` entries sit in `bridge/edith.mcp.json`:

- **`github`** — GitHub's official remote MCP (`https://api.githubcopilot.com/mcp/`).
  Free with a fine-grained personal access token — no OAuth app, no plan, no
  bill. One-time setup:

  1. Open <https://github.com/settings/personal-access-tokens> → **Generate new
     token**. Fine-grained; name it (say, `edith`); resource owner: yourself.
  2. **Repository access** → *Only select repositories* — the repos EDITH may
     read. **Permissions** → Repository → **Contents: Read-only** — that alone
     covers reading code, issues and pull requests. (Add **Pull requests:
     Read and write** only if you want EDITH to open PRs, and only run that
     bridge with `npm run bridge:writes`.)
  3. **Generate token**, copy the `github_pat_…` value into `.env.local`
     (gitignored) as `GITHUB_MCP_PAT=github_pat_…`, and restart the bridge.

  The entry ships enabled and reads `${GITHUB_MCP_PAT}` from the environment at
  boot — the token itself never sits in the tracked JSON. With the variable
  unset the server simply stays off and the boot log says so in one line;
  nothing else breaks. `npm run setup` reports whether the variable is set.
- **`zapier`** — one Zapier MCP URL (<https://mcp.zapier.com> → New MCP Server)
  covers Gmail, Google Calendar, Sheets and Drive — paste it as `url` and set
  `"enabled": true`. Pipedream works the same way.
- **`pipedream`** — already enabled, scoped by `"app"` (`gmail`, `github`, …).
  Auth is automatic: put `PIPEDREAM_CLIENT_ID`, `PIPEDREAM_CLIENT_SECRET` and
  `PIPEDREAM_PROJECT_ID` in `.env.local` (pipedream.com → your project →
  Settings → OAuth credentials / project id) and the bridge mints and
  refreshes its own access token. Note the accounts live per project —
  connect Gmail/GitHub inside your Pipedream project, not only at
  chat.pipedream.com. Set `"app": ""` and give the server a
  `PIPEDREAM_EXTERNAL_USER_ID` to browse every connected app instead.

Restart the bridge; the boot log prints `MCP server "github" up — N tools` and
the SYSTEMS rail on the HUD lights up. Reads (list mail, read issues) run
immediately; **effectful actions — sending mail, opening a PR — still need
`npm run bridge:writes`**, the same gate every other tool passes through.

> `bridge/edith.mcp.json` is **not** gitignored (only `*.local` is). Anything
> you paste in there must never be committed.

A few things you can say:

- *"What's happening in AI this week?"*
- *"Open my GitHub notifications."* (Chrome)
- *"Look at this — what am I holding?"* (camera)
- *"Make it amber and strip the chrome down to just the panel."*

### The heads-up display

The boot sequence plays a four-beat Iron Man start-up (`src/ui/Boot.tsx`) —
status bar, reticle rings resolving into "E.D.I.T.H", suit schematic, arc reactor — with EDITH speaking her boot line *through* it (a good fifteen seconds, starting just past the reactor fanfare) over your intro track (`public/audio/intro-music.mp3`, falling back to `boot-music.mp3`), so she is still finishing as the live HUD comes up and the music blooms under her last words.

---

## Controls

| Key / phrase | Does |
|---|---|
| **"Edith"** (or "Trinity") | Wake him |
| **Space** | Talk without the wake word |
| Just speak | Interrupt him mid-sentence (barge-in) |
| **V** | Cycle the browser voice |
| **Escape** | Stand down |
| **D** | Live diagnostics panel |
| **T** | One-line audio self-test |

---

## Configuration

Everything lives in `.env.local` (copy `.env.example`). Bridge settings are
read from the environment; frontend settings from Vite.

### Bridge

| Variable | Default | Effect |
|---|---|---|
| `GROQ_API_KEY` | — | Enables the fast tier (console.groq.com) and Whisper transcription for the mic |
| `NVIDIA_API_KEY` | — | Enables the smart tier (build.nvidia.com) |
| `JARVIS_ROUTING` | `hybrid` | `hybrid` \| `groq` \| `nemotron` |
| `JARVIS_ROUTE` | — | `smart-first` inverts the promotion order |
| `JARVIS_GROQ_MODEL` | auto-resolved | Pin the fast-tier model |
| `JARVIS_NEMOTRON_MODEL` | auto-resolved | Pin the smart-tier model |
| `JARVIS_THINKING` | off | `1` enables Nemotron's reasoning trace |
| `JARVIS_MAX_TOKENS` | `1024` | Reply cap per model call |
| `JARVIS_MAX_STEPS` | `16` | Tool round-trips per turn |
| `JARVIS_BRIDGE_PORT` | `8787` | Port for the WebSocket + HTTP endpoints |
| `JARVIS_ALLOW_WRITES` | off | `1` allows effectful tools (see below) |
| `JARVIS_ALLOWED_ORIGINS` | local dev | Extra WebSocket origins to accept |
| `JARVIS_ALLOW_NO_ORIGIN` | off | Accept connections with no `Origin` header |
| `JARVIS_FILE_ROOTS` | — | Extra roots the `/file` endpoint may serve from |
| `JARVIS_VOICE_ID` | George | ElevenLabs voice id |
| `ELEVENLABS_API_KEY` | — | Optional; enables the ElevenLabs voice; Scribe transcribes the mic when no Groq key is set |
| `FISH_API_KEY` + `FISH_VOICE_ID` | — | Optional; speaks through a custom voice from fish.audio (free `s2.1-pro-free` model) |
| `JARVIS_TTS_PROVIDER` | auto | `fish` \| `elevenlabs` — which cloud voice `/tts` uses; auto prefers Fish when fully configured |
| `JARVIS_STT_PROVIDER` | auto | `groq` \| `elevenlabs` — which engine `/stt` transcribes the mic with; auto prefers Groq when its key is set |
| `JARVIS_STT_MODEL` | `whisper-large-v3-turbo` | Pin the Groq transcription model |

### Frontend (`.env.local`)

| Variable | Effect |
|---|---|
| `VITE_BACKEND` | `bridge` (default) or `direct` |
| `VITE_BRIDGE_URL` | Where to reach the bridge |
| `VITE_PROVIDER_API_KEY` | Direct mode only |
| `VITE_DIRECT_BASE_URL` | Direct mode only (any OpenAI-compatible host) |
| `VITE_TTS_ENGINE` | `system` or `kokoro` |
| `VITE_KOKORO_VOICE` | Voice for the Kokoro engine |
| `VITE_USE_ELEVENLABS` | Force the ElevenLabs voice on |

### Enabling actions

The tool gate starts **read-only**. Search, fetching, the display, the camera
and page reads run freely; anything effectful — send, tap, delete, install,
pay — is denied. Voice is a poor interface for a confirmation dialog, so the
decision is made ahead of time in `decideTool()` in `bridge/server.mjs`, not
at the moment of use.

To allow effectful tools, run the bridge this way instead:

```bash
npm run bridge:writes
```

> Read `decideTool()` before you do. *"Edith, clean up my downloads
> folder"* means something rather different with writes enabled.

---

## Troubleshooting

**I can't hear him, or he can't hear me.** Press **D** for the diagnostics
panel — it states plainly whether he is hearing you and whether he is
producing sound. Press **T** for a one-line audio self-test.

**No voice at all.** You must be in **Chrome or Edge**, in a **real browser
window** (not an embedded preview), and you must have **allowed the
microphone**.

**Bridge not reachable.** Check that `npm run bridge` is still running in its
terminal, and that nothing else is holding port `8787`.

**"Both providers have turned me away."** You hit the free tier's rate limit
on both providers — Groq's daily request cap is the usual one. It clears on
its own; or pin the routing to whichever provider still has headroom with
`JARVIS_ROUTING`.

**A tool badge lights but nothing happens.** The tool was refused by the
read-only gate. Start the bridge with `npm run bridge:writes` if you want it
to act.

**The camera says it cannot read a frame.** `look`/`watch` need a
vision-capable model on at least one configured provider (Groq's Llama 4
Maverick or an NVIDIA `*vl` model). `npm run setup` reports whether one is
listed.

---

## Security

All of this lives in `bridge/server.mjs` (and `net.mjs`):

- The WebSocket accepts only local dev origins (add more with
  `JARVIS_ALLOWED_ORIGINS`).
- `/file`, `/img` and `/media` validate the scheme, confine to allowed roots,
  resolve the real path, and refuse private and loopback addresses (SSRF
  guard), with per-connection DNS re-binding protection.
- The tool gate (`decideTool`) is default-deny for effectful tools.
- A strict CSP in `index.html`; model-authored panel HTML is sanitised.
- Provider keys never reach the browser in bridge mode.

---

## Credits & licence

MIT. Forked from [adewaskar/jarvis](https://github.com/adewaskar/jarvis) —
same face, same voice pipeline, same security posture; the brain is new.
The boot sound and any tracks in `public/audio/` ship with the project for
the demo. If you go on to monetise something built on this, clearing the
rights to that audio is your responsibility.
