// JARVIS's eyes.
//
// Everything else in this bridge pushes: a panel appears, a blade opens, the
// interface retints. This is the one capability that has to ask and wait — the
// camera is in the browser, the model is here, and a frame has to travel back.
// So it rides a request/reply channel rather than the one-way stream the rest
// of the tools use.
//
// Worth being deliberate about what this is. It turns on a camera pointed at
// the user's face and hands the picture to a model. That is a reasonable thing
// to do when they have just said "look at me", and an unreasonable thing to do
// because a model got curious mid-answer. Three things keep it honest:
//
//   - the browser refuses unless the page is already allowed the camera, so the
//     operating system's own permission still gates it;
//   - the indicator is on screen for the whole time the camera is live, and the
//     hardware light is on with it;
//   - the persona is told, in as many words, to use it only when asked to look.
//
// No frame is stored. It is captured, encoded, handed to a vision model for
// the turn, and gone. (Under the Claude SDK the frame travelled back as an
// image block; under the OpenAI-compatible providers the main brain may be
// text-only — Nemotron 3 is — so the frame is described by a vision-capable
// model on the same keys, and the description rides back as text.)

import { describeImage } from './llm.mjs'

const DESCRIPTION = `Look through the camera at whoever is in front of the screen.

Captures one frame and returns a factual description of what it shows.

Use it when the user asks you to look — "what am I holding", "how do I look",
"is anyone behind me", "read this label", "what colour is this". Anything where
the answer is in front of the camera rather than on the machine.

Do NOT use it speculatively. It switches on a camera pointed at their face, and
the indicator and the hardware light both come on. Take a picture because they
asked you to take a picture, not because a picture might be informative.

One frame per question. If you need to see something again after they have
moved or turned it around, take another — do not ask them to hold still while
you reason about a picture you already have.`

const WATCH_DESCRIPTION = `Watch through the camera over time, not just once.

Returns a description drawn from a grid of frames from a few seconds of video,
in order, each stamped with its offset. That is how motion becomes something
you can actually read: one still tells you what is there, a grid tells you what
CHANGED.

Use it when the answer is in the movement rather than the moment — "am I doing
this right", "what am I doing wrong", "watch my form", "did that work", "what
just happened". Anything where a single photograph would miss the point.

Two directions, and choosing correctly matters:
  now  — record the next few seconds. For "watch me do this", where the thing
         has not happened yet when they ask.
  past — the seconds that have ALREADY happened. For "what did I just do",
         which cannot be answered by starting to record when asked. Only works
         while the camera is open on screen; if it is not, say so and offer to
         open it and watch again.

Keep it short. Six seconds is usually plenty, and a longer window spreads the
same number of frames thinner rather than showing you more.

Describe what you saw as a sequence — what changed between the frames — rather
than listing them. The user knows what their own hands look like.`

const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })
const ok = (text) => ({ content: [{ type: 'text', text }] })

/** The instruction the vision model itself receives for a single frame. */
const LOOK_PROMPT =
  'Describe what is visible in this single camera frame: the people and what ' +
  'they are doing, objects held or nearby, any legible text, and anything ' +
  'unusual. Be factual and specific. Plain prose, under 120 words.'

/** The instruction for a grid of stamped frames. */
const WATCH_PROMPT =
  'These frames are one continuous clip from a camera, shown as a grid, each ' +
  'stamped with its time offset. Read them left to right, top to bottom. ' +
  'Describe what happens as a sequence — what appears, moves, changes or goes ' +
  'wrong between the frames. Be factual and specific. Plain prose, under 150 words.'

/**
 * @param {(kind: string, args?: object, timeoutMs?: number) => Promise<object>} ask
 *   Sends a request to the browser and resolves with its reply.
 */
export function visionTools({ ask }) {
  return [
    {
      name: 'look',
      description: DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description:
              'A few words on what you are looking for, shown to the user while ' +
              'the camera is live. They can see the light; tell them why.',
          },
        },
      },
      async execute(args) {
        let reply
        try {
          reply = await ask('capture', { reason: String(args.reason ?? '').slice(0, 80) })
        } catch (err) {
          return refuse(
            `Could not reach the camera: ${err?.message ?? err}. ` +
              'Tell the user you cannot see and carry on without it.',
          )
        }

        if (reply?.error) {
          // Worded so the model can pass it on as one plain sentence. A denied
          // camera is a fact about the machine, not a failure to apologise for.
          return refuse(String(reply.error))
        }
        if (typeof reply?.data !== 'string' || !reply.data) {
          return refuse('The camera returned nothing.')
        }

        try {
          const seen = await describeImage({
            data: reply.data,
            mimeType: reply.mimeType ?? 'image/jpeg',
            prompt: LOOK_PROMPT,
          })
          return ok(seen.text)
        } catch (err) {
          return refuse(
            `The frame was captured but could not be read: ${err?.message ?? err}.`,
          )
        }
      },
    },

    {
      name: 'watch',
      description: WATCH_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          seconds: {
            type: 'number',
            description: 'How long to watch, 2 to 15. Default 6.',
          },
          when: {
            type: 'string',
            enum: ['now', 'past'],
            description:
              'now = watch what happens next, starting immediately. ' +
              'past = look at the seconds that have ALREADY happened, which ' +
              'only works while the camera is open on screen.',
          },
          reason: {
            type: 'string',
            description: 'A few words on what you are watching for, shown on screen.',
          },
        },
      },
      async execute(args) {
        let reply
        try {
          reply = await ask(
            'capture',
            {
              mode: 'watch',
              seconds: Number(args.seconds) || 6,
              when: args.when ?? 'now',
              reason: String(args.reason ?? '').slice(0, 80),
            },
            // Generous: a forward watch genuinely takes as long as it says it
            // will, and timing out mid-recording would discard the whole clip.
            45_000,
          )
        } catch (err) {
          return refuse(
            `Could not watch: ${err?.message ?? err}. Tell the user and carry on.`,
          )
        }
        if (reply?.error) return refuse(String(reply.error))
        if (typeof reply?.data !== 'string' || !reply.data) {
          return refuse('The camera returned nothing.')
        }
        try {
          const seen = await describeImage({
            data: reply.data,
            mimeType: reply.mimeType ?? 'image/jpeg',
            prompt: WATCH_PROMPT,
          })
          return ok(seen.text)
        } catch (err) {
          return refuse(
            `The clip was captured but could not be read: ${err?.message ?? err}.`,
          )
        }
      },
    },
  ]
}
