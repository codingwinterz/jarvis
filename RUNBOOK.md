# EDITH — Runbook

Everything you need to open, run, and troubleshoot EDITH on this machine
without an assistant. Written for this setup: Fish Audio voice out, Groq
Whisper in, NVIDIA-first chat, autostart at Windows login.

Repo: `C:\Users\fiery\Documents\Trinity\edith`

---

## 1. Normal day-to-day (already installed)

1. **Sign in to Windows.** The EDITH window opens by itself.
   The launcher lives at:
   `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\EDITH.vbs`
   It starts the brain (port 8787) and the face (port 5173) hidden, logging to
   `edith\logs\boot.log`, then opens the chromeless app window.
2. Click **INITIALISE**, allow the microphone if asked.
3. Say **"Edith"** (or **"Trinity"** / **"Jarvis"** — all three wake it) to talk hands-free, or
   hold **SPACE** to talk, **G** for hand tracking, **V** to cycle the native
   test voice, **D** for diagnostics, **T** for a speaker test.

## 2. If the window/stack did NOT start

Open **Git Bash** (or any terminal):

```bash
cd /c/Users/fiery/Documents/Trinity/edith
node scripts/boot.mjs run     # starts the stack and opens the app window
```

Or run the halves separately:

```bash
npm run bridge                # the brain  → ws://localhost:8787
npm run dev                   # the face   → http://localhost:5173 (open in Chrome)
```

One command for both: `npm start`.

If ports complain, a stale copy is running: `npm run boot:stop`, then retry.

## 3. Management commands

```bash
npm run boot:stop      # end the running session (bridge + face + window)
npm run boot:install   # (re)install the at-login launcher
npm run boot:remove    # stop starting at login
npm run setup          # preflight: checks Node, both keys, mic/voice config
npm run lint           # code sanity check
npm run build          # production build (tsc + vite)
```

Logs: `edith\logs\boot.log` (PowerShell: `Get-Content logs\boot.log -Tail 50`).

## 4. Health checks (copy-paste)

```bash
# Bridge + speech engines — expect:
# {"ok":true,"tts":true,"stt":true,"sttEngine":"groq","voice":"fish"}
curl http://localhost:8787/health

# UI — expect 200
curl -o /dev/null -w '%{http_code}\n' http://localhost:5173

# End-to-end voice out — expect HTTP 200 and an mp3
curl -o /tmp/t.mp3 -w '%{http_code}\n' -X POST http://localhost:8787/tts \
  -H 'Content-Type: application/json' -d '{"text":"test"}'
```

In the app, press **D**: LISTENING → `recogniser running`, SPEAKING →
`engine: fish`. Any other engine name tells you which fallback you landed on.

## 5. When a free limit runs out (what you see → what to do)

| You see | Cause | What happens / fix |
|---|---|---|
| Reply error with **413 … TPM Limit 8000** or **429 Usage limit** | Groq free tier (8k tokens/min, ~1k req/day, 200k tokens/day) | Chat no longer needs Groq — turns start on **NVIDIA** (`JARVIS_ROUTE=smart-first`) and only fall back to Groq. **Daily limits reset** (US Pacific midnight); nothing to do but wait. |
| **Voice commands stop transcribing** | Groq free daily quota (Whisper uses the same key, ~2,000 transcription requests/day) | Wait for the daily reset, or temporarily use **SPACE** push-to-talk with keyboard... transcription still needs a provider, so the fallback is the browser's own recognition (Chrome only, flakier). An `ELEVENLABS_API_KEY` in `.env.local` adds Scribe as a second STT engine (`JARVIS_STT_PROVIDER=elevenlabs`). |
| Turn errors mentioning **nvidia** or **Nemotron** | NVIDIA free quota (resets daily) | Turns fall back to Groq; small turns still work, big tool turns may 413 until NVIDIA resets. Wait for reset. |
| Wrong/system voice on some replies | Fish Audio transient 500 ("Failed to download reference audio") | Sentence-level, self-healing — next sentence uses the EDITH voice again. Check with the `/tts` curl in §4. |
| **402 Insufficient API credit** from Fish | A paid Fish model was selected | `FISH_MODEL` must stay `s2.1-pro-free` (the default). Paid models need funds at fish.audio → Developers. |
| Everything dead, ports busy | Stale processes | `npm run boot:stop`, confirm with `netstat -ano | grep -E ':(8787|5173)'`, then `node scripts/boot.mjs run`. |

**Keys live in `edith\.env.local`** (never committed, never share):

```
GROQ_API_KEY=…          # chat fallback + Whisper mic transcription
NVIDIA_API_KEY=…        # primary chat brain (Nemotron)
FISH_API_KEY=…          # voice output
FISH_VOICE_ID=…         # your EDITH voice
JARVIS_ROUTE=smart-first  # keep: Groq's free tier can't afford one big turn
```

Restart the stack after editing it (`npm run boot:stop`, then
`node scripts/boot.mjs run`).

## 6. Fresh install (new machine or from scratch)

1. Install **Node.js 20+** and **Chrome**.
2. `npm install`
3. `cp .env.example .env.local` and fill in the keys above
   (free keys: console.groq.com, build.nvidia.com, fish.audio).
4. `npm run setup` — live-probes both providers and the voice config.
5. `npm start` → open http://localhost:5173 in Chrome → INITIALISE.
6. `npm run boot:install` to make it start at every sign-in.

## 7. Ground rules

- The bridge must run for anything to work; the window can be reloaded freely.
- Mic and camera only work in a real Chrome/Edge window (the app window counts).
- The tool gate is **read-only by default**; `npm run bridge:writes` enables
  effectful actions — read `decideTool()` in `bridge/server.mjs` first.
- Speech engines are chosen automatically at page load and keep retrying if
  the bridge was late; a stale page is fixed by reloading the window (F5).

## 8. Full laptop access (enabled on this setup)

EDITH has the machine, deliberately:

- `JARVIS_ALLOW_WRITES=1` (`.env.local`) — effectful tools are allowed: file
  writes, chrome click/type, installs. The verb gate in `decideTool()` still
  classifies every call, but nothing is denied by policy anymore.
- `JARVIS_FILE_ROOTS=C:\` — the bridge's `/file` endpoint may serve images
  from anywhere on the drive, not just the home and temp folders.
- MCP `filesystem` server (`bridge/edith.mcp.json`) — 14 file tools (read,
  list, search, tree, write, edit, move, create) rooted at `C:\`. It starts
  with the bridge; the first boot downloads it via npx (cached afterwards).

**To take it away again:** comment out the two `.env.local` lines, set
`"enabled": false` on the `filesystem` entry, restart the stack.

**Ground rules while it is on:** the bridge binds localhost only — do not put
it behind a tunnel or public URL while writes are enabled. The gate is a verb
heuristic, not a confirmation dialog: a voice request that reaches a delete or
write tool simply runs. There is no undo for a file EDITH removes — the
filesystem MCP works as your Windows user, exactly like you would.
