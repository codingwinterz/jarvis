import OpenAI from 'openai'
import { env, MODEL, DIRECT_BASE_URL, SYSTEM_PROMPT, activeServers } from '../config'

/**
 * The browser-direct path — the non-default backend (see brain.ts).
 *
 * Any OpenAI-compatible endpoint works here: Groq's by default, since it
 * needs only a free key and is the fastest thing that fits in a browser tab.
 * The bridge path is still the recommended one; this exists for a demo with
 * nothing to run but a static page.
 *
 * What direct mode deliberately does NOT have: the tool surface. Panels, the
 * interface controls, the camera and Chrome all run in the bridge process and
 * push down its socket — a one-shot HTTPS request has no channel for any of
 * that, which is exactly why the bridge exists. Direct mode is conversation
 * only.
 *
 * `dangerouslyAllowBrowser` is the SDK's acknowledgement that this exposes the
 * key to anyone who opens devtools, which is acceptable for a local demo and
 * not for a public deploy.
 */
const client = new OpenAI({
  apiKey: env.providerKey || 'missing-key',
  baseURL: DIRECT_BASE_URL,
  dangerouslyAllowBrowser: true,
})

/** The conversation-history shape both backends speak. */
export type Msg = { role: 'user' | 'assistant'; content: string }

export type AskHandlers = {
  /** Fires for each chunk of the spoken answer. */
  onText: (delta: string) => void
  /** Fires when a tool starts — always 'none' on this path, which has no tools. */
  onTool: (name: string) => void
}

/** The stream for the turn in flight, so a barge-in can abort it. Without
 *  this, cutting JARVIS off only silenced the speaker: the model kept
 *  generating into a browser nobody was listening to. */
let active: AbortController | null = null
let cancelled = false

/**
 * One turn of conversation, streamed. No tool loop here on purpose — see the
 * header. Barge-in aborts the stream, which stops the tokens and the quota
 * along with the voice.
 */
export async function ask(
  history: Msg[],
  handlers: AskHandlers,
): Promise<{ text: string; tools: string[] }> {
  cancelled = false
  const ac = new AbortController()
  active = ac
  let text = ''

  try {
    const stream = await client.chat.completions.create(
      {
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...history.map((m) => ({ role: m.role, content: m.content })),
        ],
        stream: true,
        temperature: 0.6,
        max_tokens: 1024,
      },
      { signal: ac.signal },
    )

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content
      if (typeof delta === 'string' && delta.length) {
        text += delta
        handlers.onText(delta)
      }
      if (cancelled) break
    }
    return { text: text.trim(), tools: [] }
  } catch (err) {
    // A barge-in aborts this stream on purpose. That surfaces as a rejection,
    // and it isn't an error the user should see a toast for — hand back what
    // he'd already said.
    if (cancelled || ac.signal.aborted) {
      return { text: text.trim(), tools: [] }
    }
    throw err
  } finally {
    active = null
  }
}

/**
 * Barge-in. Stops the generation rather than just muting it, so cutting JARVIS
 * off stops the tokens and the quota along with the voice.
 */
export function cancel(): void {
  cancelled = true
  active?.abort()
}

/** Labels for the HUD's SYSTEMS rail. Direct mode reaches only what the key
 *  covers, so the rail shows the configured remote servers' names — what is
 *  *configured*, not what is reachable. */
export function connectedLabels(): string[] {
  return activeServers().map((s) => s.label)
}
