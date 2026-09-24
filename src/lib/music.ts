/**
 * Score.
 *
 * Three cues, all local files under public/audio/:
 *   intro-music — your own track, once, starting WITH EDITH's boot line a
 *                 couple of seconds into the start-up sequence and blooming
 *                 out from under her voice when she finishes. Drop any mp3
 *                 in as intro-music.mp3 (boot-music.mp3 is the fallback);
 *                 with no file there the cue silently skips and only the
 *                 line speaks.
 *   ambient     — the opening bed, once, across the boot sequence
 *   work        — an industrial cue that loops while a tool is running
 *
 * Only `work` repeats. The other two belong to the power-up and are over when
 * it is: an interface that keeps playing music at you for as long as it is open
 * is one you end up muting, and a muted assistant loses the sounds that
 * actually carry meaning — the wake tone, the tool tick, the completion chime.
 *
 * The shipped cues are Kevin MacLeod (incompetech.com), CC BY 4.0 — free to
 * use with attribution and safe on a monetised channel, unlike the actual film
 * score, which would be claimed within a day of upload. intro-music is your
 * own track; honour whatever licence it carries.
 *
 * Everything degrades quietly: if a file is missing the cue simply doesn't
 * play, and the synthesised bed in sfx.ts covers the ambient case.
 */

type Cue = 'intro-music' | 'ambient' | 'work'

type Track = {
  el: HTMLAudioElement
  fade: number | null
}

const tracks = new Map<Cue, Track>()
/** Cues whose file failed to load. Retrying only spends another 404. */
const missing = new Set<Cue>()
/**
 * One-shot cues that have finished. They are never started again.
 *
 * This exists because of a genuinely nasty interaction. `fadeTo` starts a cue
 * whenever it is asked for a level above zero and finds the element paused —
 * which is the right rule for a bed that should be running, and completely
 * wrong for a track that has ENDED, because an ended element is also a paused
 * one. Ducking asks for ambient's level every time JARVIS stops speaking, so
 * the opening music was being resurrected from the top after every single
 * sentence. It never looped; it was raised from the dead once a turn.
 */
const finished = new Set<Cue>()
const ALL: Cue[] = ['intro-music', 'ambient', 'work']
let enabled = false

/** Resting levels. Music sits well under the voice — it is atmosphere, not a
 *  soundtrack, and JARVIS has to stay intelligible over it. */
const LEVEL: Record<Cue, number> = {
  // The intro track's resting level: where it sits once she has finished the
  // line and blooms out from under the duck. It STARTS already ducked
  // (duck(true) before playBoot), so while she speaks it rides at that level —
  // present, not competing. The ambient bed underneath stays a whisper.
  'intro-music': 0.85,
  /**
   * Under the intro, not alongside it.
   *
   * This has been wrong in both directions. At 0.075 — the level it had as an
   * all-session whisper — it was inaudible beneath a start-up sound at 0.85,
   * technically playing and no different from silence. At 0.2 it was audible
   * and competing: the intro is the thing with words in it, and two pieces of
   * music at similar levels means neither is heard properly.
   *
   * 0.1 is the compromise that respects the ordering. The intro carries; the
   * track is present underneath it rather than beside it.
   */
  ambient: 0.1,
  work: 0.11,
}

/**
 * Where each cue currently wants to sit, before ducking. Kept separately from
 * the element volume so the two systems compose: a tool starting while JARVIS
 * is speaking brings the work cue in at its ducked level rather than at full,
 * and it rises the rest of the way when he stops.
 */
const want: Record<Cue, number> = { 'intro-music': 0, ambient: 0, work: 0 }

let ducked = false
/** How far the bed drops under the voice. */
const DUCK = 0.35

function track(cue: Cue): Track | null {
  if (!enabled || missing.has(cue)) return null
  let t = tracks.get(cue)
  if (!t) {
    const el = new Audio(`/audio/${cue}.mp3`)
    el.preload = 'auto'
    // Only the work cue repeats. It has to, because it covers an operation of
    // unknown length; the two power-up cues are events with an end.
    el.loop = cue === 'work'
    el.volume = 0
    // A missing file is not an error worth surfacing — the interface just
    // runs without that layer. The one nuance is the intro slot: the name a
    // dropped-in start-up track most often arrives under is boot-music.mp3
    // (what this cue used to be called), so a missing intro-music.mp3 retries
    // once under that name before giving up. Without the fallback the boot
    // runs with no music at all and nothing on screen says why.
    let retried = false
    const onMissing = () => {
      if (cue === 'intro-music' && !retried) {
        retried = true
        // Assigning src re-runs the media load, so boot-music.mp3 either
        // takes the slot or fires error again and the branch below runs.
        el.src = '/audio/boot-music.mp3'
        return
      }
      el.removeEventListener('error', onMissing)
      tracks.delete(cue)
      missing.add(cue)
    }
    el.addEventListener('error', onMissing)
    // A cue that has played out is over. Zeroing `want` as well as recording it
    // means every later level calculation agrees, rather than leaving a stale
    // target for something to act on.
    el.addEventListener(
      'ended',
      () => {
        finished.add(cue)
        want[cue] = 0
      },
      { once: true },
    )
    t = { el, fade: null }
    tracks.set(cue, t)
  }
  return t
}

/** Must be called from a user gesture — browsers block audio before one. */
export function enable() {
  enabled = true
  // Warm the files so the intro cue starts on time rather than after a buffer.
  ALL.forEach(track)
}

/**
 * The level a cue should actually be at right now.
 *
 * The intro cue used to be exempt from ducking — when it was a swell over the
 * silent animation, pulling it down mid-flight read as a fault. It now plays
 * under EDITH's boot line, so ducking it IS the feature: down under her voice,
 * back up when she has finished, like everything else that makes a sound.
 */
function level(cue: Cue): number {
  return ducked ? want[cue] * DUCK : want[cue]
}

function fadeTo(cue: Cue, to: number, ms: number) {
  const t = track(cue)
  if (!t) return
  if (t.fade !== null) cancelAnimationFrame(t.fade)
  const from = t.el.volume
  const start = performance.now()
  const step = () => {
    const k = Math.min(1, (performance.now() - start) / ms)
    t.el.volume = from + (to - from) * k
    if (k < 1) t.fade = requestAnimationFrame(step)
    else {
      t.fade = null
      if (to === 0) t.el.pause()
    }
  }
  // `finished` is what stops an ended one-shot being restarted by a later
  // request for its level — see the note where it is declared.
  if (to > 0 && t.el.paused && !finished.has(cue)) void t.el.play().catch(() => {})
  t.fade = requestAnimationFrame(step)
}

/** Set a cue's resting level and ramp to wherever that lands it. */
function set(cue: Cue, to: number, ms: number) {
  want[cue] = to
  fadeTo(cue, level(cue), ms)
}

/** The intro cue's own dissolve, held so stopAll can cancel it. */
let dissolve: ReturnType<typeof setTimeout> | null = null

/**
 * The intro cue. Your track, once: started the moment EDITH begins her boot
 * line, a couple of seconds into the start-up sequence, so it plays under her
 * voice from the first syllable rather than arriving after she has finished
 * talking. It arrives already
 * ducked (App ducks before calling this), holds under her voice, blooms when
 * she finishes, and dissolves near the end of whatever clip is actually there.
 */
export function playBoot() {
  const t = track('intro-music')
  if (!t) return
  // Allowed to play again on a re-power — same rule as startAmbient: an
  // explicit power-up is the one thing that may replay a one-shot.
  finished.delete('intro-music')
  t.el.currentTime = 0
  // Fast in — it has to be present from her first syllable.
  set('intro-music', LEVEL['intro-music'], 120)
  /**
   * Dissolve near the end of whatever clip is actually there.
   *
   * This used to be a hardcoded fourteen seconds, measured off the clip that
   * happened to ship. Drop in a shorter one and the cue ends in silence long
   * before the fade starts; a longer one gets cut off mid-phrase. Reading the
   * duration means the boot sound is a file you can replace rather than a file
   * plus a constant somebody has to remember to change with it.
   */
  if (dissolve) clearTimeout(dissolve)
  const arm = () => {
    const secs = Number.isFinite(t.el.duration) && t.el.duration > 1 ? t.el.duration : 17
    // Start the fade far enough from the end that it is a dissolve rather than
    // a cut, and never sooner than half a second in.
    const at = Math.max(500, (secs - 2.6) * 1000)
    dissolve = setTimeout(() => {
      dissolve = null
      set('intro-music', 0, 2500)
    }, at)
  }
  if (t.el.readyState >= 1) arm()
  else t.el.addEventListener('loadedmetadata', arm, { once: true })
}

/**
 * The opening music. Once, from the top, and then it is finished.
 *
 * The four-second fade this used to have made sense for a bed that ran all
 * session — it had all the time in the world to arrive. For a cue that plays
 * once alongside the boot sequence it was spending a third of the track easing
 * in, so it is short now: present from the first beat, like the start-up sound
 * it plays under.
 *
 * Nothing stops it. The element does not loop, so it ends when the track ends.
 */
export function startAmbient() {
  const t = track('ambient')
  if (!t) return
  // From the top every time, so a second power-up in the same page sounds like
  // the first rather than resuming wherever the last one left off. Deliberately
  // clearing `finished` too: an explicit power-up is the one thing that IS
  // allowed to play it again.
  finished.delete('ambient')
  t.el.currentTime = 0
  set('ambient', LEVEL.ambient, 900)
}

export function stopAll() {
  if (dissolve) {
    clearTimeout(dissolve)
    dissolve = null
  }
  ALL.forEach((c) => {
    want[c] = 0
    // Only touch cues that exist — asking for one that was never played would
    // otherwise construct an Audio element purely in order to silence it.
    if (tracks.has(c)) fadeTo(c, 0, 600)
  })
}

/** The work cue rises while a tool runs and falls the moment it's done. */
export function working(on: boolean) {
  set('work', on ? LEVEL.work : 0, on ? 900 : 1400)
}

/** Pull the bed down while JARVIS speaks so the voice stays clear. */
export function duck(on: boolean) {
  if (ducked === on) return
  ducked = on
  // Down quickly, back up slowly: the drop has to be out of the way before the
  // first syllable, but a fast recovery is audible as a swell. The intro cue is
  // in the list because it now plays under a voice rather than over a silent
  // animation.
  ;(['intro-music', 'ambient', 'work'] as Cue[]).forEach((c) => {
    if (tracks.has(c)) fadeTo(c, level(c), on ? 250 : 900)
  })
}
