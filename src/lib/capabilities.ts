import { BACKEND, BRIDGE_HTTP_URL, env } from '../config'

/**
 * What speech engines are actually available, decided once at boot.
 *
 * The whole point is that the app runs for anyone. A student who has done
 * nothing but a free provider key gets the browser's own speech
 * recognition and voice — no keys, no accounts, it just works. A student whose
 * brain already runs on a free provider key gets cloud transcription too:
 * Groq's Whisper on the Groq key, ElevenLabs Scribe on an ElevenLabs key —
 * automatically, with no flag to set. This module is how the rest of the app
 * learns which of those worlds it is in, so voice.ts and tts.ts never have to
 * guess.
 *
 * The premium paths both live behind the bridge — it holds the key and makes
 * the calls, so the browser never sees a secret. In direct mode (no bridge)
 * only a key baked into the bundle could reach ElevenLabs for speech, and that
 * is not a path worth encouraging, so direct mode is treated as browser-only.
 */

export type Capabilities = {
  /** Cloud speech-to-text (Groq Whisper or ElevenLabs Scribe) is reachable via the bridge. */
  stt: boolean
  /** Which transcriber the bridge will use; null when there is none. */
  sttEngine: 'groq' | 'elevenlabs' | null
  /** A cloud text-to-speech engine is reachable via the bridge. */
  tts: boolean
  /** Which cloud voice the bridge speaks with — ElevenLabs or Fish Audio. */
  voice: 'elevenlabs' | 'fish'
}

/** Browser-only until the probe says otherwise. Safe default: the app works. */
let current: Capabilities = { stt: false, sttEngine: null, tts: false, voice: 'elevenlabs' }
let probed = false

/** The last known capabilities. Read synchronously by the voice and speech
 *  layers; accurate once `probeCapabilities` has resolved during boot. */
export function caps(): Capabilities {
  return current
}

export function capabilitiesProbed(): boolean {
  return probed
}

/**
 * Ask the bridge what it can do. Called during the boot sequence, before the
 * voice loop starts, so the first "Hey Jarvis" already uses the right engine.
 * Never throws: a failed probe returns the browser-only defaults rather than
 * blocking boot on a health check that is only an optimisation.
 */
export async function probeCapabilities(): Promise<Capabilities> {
  if (BACKEND !== 'bridge') {
    // No bridge to ask. Direct mode has no server-side speech, so browser only.
    current = { stt: false, sttEngine: null, tts: false, voice: 'elevenlabs' }
    probed = true
    return current
  }
  if (!(await probeOnce())) keepProbing()
  probed = true
  return current
}

/** Ask once. True when the bridge answered and `current` was refreshed. */
async function probeOnce(): Promise<boolean> {
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return false
    const h = (await res.json()) as {
      stt?: boolean
      sttEngine?: string
      tts?: boolean
      voice?: string
    }
    const engine = h.sttEngine === 'groq' ? 'groq' : h.sttEngine === 'elevenlabs' ? 'elevenlabs' : null
    current = {
      stt: Boolean(h.stt),
      // A bridge older than sttEngine only ever meant Scribe by `stt`.
      sttEngine: h.stt ? (engine ?? 'elevenlabs') : null,
      tts: Boolean(h.tts),
      voice: h.voice === 'fish' ? 'fish' : 'elevenlabs',
    }
    return true
  } catch {
    return false
  }
}

let retrying = false

/**
 * Keep asking, quietly, until the bridge answers.
 *
 * The window opens as soon as Vite responds, which on a cold login can beat
 * the bridge's own listen() — and a single-shot probe turns that lost race
 * into a whole session frozen on the browser fallbacks (system voice, browser
 * recogniser) that no amount of INITIALISE can shake off, with nothing on
 * screen naming the real cause. Engine choices read `current` fresh, so a
 * retry landing before INITIALISE silently corrects everything.
 */
function keepProbing() {
  if (retrying) return
  retrying = true
  void (async () => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000))
      if (await probeOnce()) {
        retrying = false
        return
      }
    }
  })()
}

/** A short human label for the HUD: what voice stack is actually in play. */
export function engineLabel(): string {
  const c = current
  const hear = c.sttEngine === 'groq' ? 'Groq' : c.sttEngine === 'elevenlabs' ? 'Scribe' : null
  const speak = c.tts ? (c.voice === 'fish' ? 'Fish Audio' : 'ElevenLabs') : null
  if (hear && speak) return `${speak} + ${hear}`
  if (speak) return `${speak} voice`
  if (hear) return `${hear} transcription`
  // env.elevenKey is only meaningful in direct mode; harmless to mention.
  if (env.elevenKey && BACKEND !== 'bridge') return 'ElevenLabs (direct)'
  return 'browser speech'
}
