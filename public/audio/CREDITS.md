# Audio credits

The two shipped tracks — `ambient.mp3` and `work.mp3` — are by
**Kevin MacLeod** (incompetech.com), licensed **Creative Commons Attribution
4.0**. Free to use commercially — including in a monetised YouTube video —
provided the attribution below appears somewhere the audience can see it (a
description box is fine). `intro-music.mp3` is your own track to add; honour
its licence the same way.

| File | Track | Used for |
|---|---|---|
| `intro-music.mp3` | *(your track — any mp3, this filename)* | The music under EDITH's boot line |
| `ambient.mp3` | *Ossuary 6 – Air* | Low bed looping under the interface |
| `work.mp3` | *Mechanolith* | Rises while a tool is running |

## Attribution to paste into a video description

```
Music by Kevin MacLeod (incompetech.com)
  "Impact Prelude"    — Licensed under Creative Commons: By Attribution 4.0
  "Ossuary 6 - Air"   — Licensed under Creative Commons: By Attribution 4.0
  "Mechanolith"       — Licensed under Creative Commons: By Attribution 4.0
http://creativecommons.org/licenses/by/4.0/
```

## Why not the actual Iron Man score

Disney/Marvel run one of the most aggressive Content ID operations on YouTube.
Real film score or JARVIS dialogue in an upload means a near-certain claim,
demonetisation, or a strike — on a video whose whole point is to be seen. These
tracks are in the same register and cost you a line of text instead.

## Replacing them

The intro slot is `intro-music.mp3` — drop your track in under that name and it
plays under EDITH's boot line; if it isn't there, the app falls back to
`boot-music.mp3` (*Impact Prelude*) automatically, so that file now earns its
keep again — with neither present the cue skips and only the line is spoken.

Other sources worth a look: incompetech.com (same
licence), Pixabay Music (CC0, no attribution at all), and the YouTube Audio
Library.

The short interface sounds — wake pips, tool ticks, the completion chime — are
not files. They're synthesised in Web Audio in `src/lib/sfx.ts`, so there's
nothing to download and nothing to credit. Drop `wake.mp3`, `listen.mp3`,
`tool.mp3`, `done.mp3` or `error.mp3` in here to override any of them.
