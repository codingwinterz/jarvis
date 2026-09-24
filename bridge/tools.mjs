// TRINITY tool registry.
//
// Everything the model can do arrives here as a plain entry:
//
//   { name, description, parameters (JSON Schema), execute(args) -> result }
//
// A result is a block list — { type:'text', text } or { type:'image', data,
// mimeType } — the same shapes the in-process tools always produced, so the
// panel, interface, browser and camera modules port over with their bodies
// unchanged and only their declaration layer swapped.
//
// This replaces what the Claude Agent SDK used to do invisibly: holding the
// tool table, validating arguments, and routing each call to its handler.
// Validation is lighter here on purpose — every handler already tolerates
// loose input, because a voice turn fails in front of the user when it fails.

import { fetchText } from './net.mjs'
import { displayTools } from './panels.mjs'
import { uiTools } from './ui.mjs'
import { chromeTools } from './chrome.mjs'
import { visionTools } from './vision.mjs'

/** A successful tool result. */
const ok = (text) => ({ content: [{ type: 'text', text }] })

/** A refusal — worded as one plain sentence, because it may be spoken. */
const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })

// ---------------------------------------------------------------------------
// Built-ins: search and fetch, with no API key anywhere.
// ---------------------------------------------------------------------------

/**
 * DuckDuckGo's html endpoint, fetched through the bridge's own SSRF gate
 * (fetchText → net.mjs). No key, no account, and good enough to answer "what
 * is happening in AI this week" — which is the bar. Results are parsed out of
 * the markup rather than an API because there is no API on this tier.
 */
const stripTags = (html) =>
  String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()

/** DuckDuckGo wraps results in redirect links; unwrap them to the real URL. */
function unwrapDdgUrl(href) {
  if (!href) return null
  let url = href
  if (url.startsWith('//')) url = 'https:' + url
  const uddg = /[?&]uddg=([^&]+)/.exec(url)
  if (uddg) {
    try {
      url = decodeURIComponent(uddg[1])
    } catch {
      return null
    }
  }
  // Ads and internal links are not results.
  if (!/^https?:\/\//i.test(url)) return null
  if (/duckduckgo\.com\/y\.js|duck\.co/i.test(url)) return null
  return url
}

const WEB_SEARCH_DESCRIPTION = `Search the public web.

Returns a ranked list: title, one-line snippet and URL for each result. Use it
for anything you would otherwise guess at — news, prices, facts past your
cutoff, who won what. For the substance of a specific page, follow it with
fetch_page and read the real text rather than the snippet.

The URL of a result with a picture or an article worth seeing goes on the
display — paste it verbatim.`

const FETCH_PAGE_DESCRIPTION = `Fetch a web page and read its actual text.

Returns the page's prose — headlines, paragraphs, figures — with markup
stripped. This is how you learn what an article says beyond its snippet, and
where the sentences you show on the display come from.

Do not fetch a page whose only point is a login wall or a live dashboard you
would rather drive in the user's own browser with the chrome_* tools.`

function builtinTools() {
  return [
    {
      name: 'web_search',
      description: WEB_SEARCH_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for.' },
          max_results: {
            type: 'number',
            description: 'How many results, 1 to 8. Default 6.',
          },
        },
        required: ['query'],
      },
      async execute(args) {
        const query = String(args.query ?? '').trim()
        if (!query) return refuse('The search had no query in it.')
        const n = Math.min(8, Math.max(1, Number(args.max_results) || 6))
        const target =
          'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query)
        let page
        try {
          page = await fetchText(target, {
            maxBytes: 2_000_000,
            timeoutMs: 12_000,
            accept: 'text/html',
          })
        } catch (err) {
          return refuse(`The search failed: ${err?.message ?? err}.`)
        }

        const anchors = [
          ...page.text.matchAll(/<a\b([^>]*class="result__a"[^>]*)>([\s\S]*?)<\/a>/g),
        ]
        const snippets = [
          ...page.text.matchAll(/<a\b[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g),
        ]

        const results = []
        for (let i = 0; i < anchors.length && results.length < n; i++) {
          const href = /href="([^"]+)"/.exec(anchors[i][1])?.[1]
          const url = unwrapDdgUrl(href)
          if (!url) continue
          const title = stripTags(anchors[i][2])
          if (!title) continue
          results.push({
            title,
            url,
            snippet: stripTags(snippets[i]?.[1] ?? ''),
          })
        }

        if (!results.length) {
          return ok(`The search returned no results for "${query}".`)
        }
        const body = results
          .map(
            (r, i) =>
              `${i + 1}. ${r.title}${r.snippet ? ` — ${r.snippet}` : ''}\n   ${r.url}`,
          )
          .join('\n')
        return ok(
          `${results.length} results for "${query}":\n\n${body}\n\n` +
            'Show the worth-seeing ones on the display, with their URLs pasted verbatim.',
        )
      },
    },

    {
      name: 'fetch_page',
      description: FETCH_PAGE_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http(s) URL.' },
          max_chars: {
            type: 'number',
            description: 'Cap the returned text. Default 6000.',
          },
        },
        required: ['url'],
      },
      async execute(args) {
        const url = String(args.url ?? '').trim()
        if (!url) return refuse('No URL was given.')
        const maxChars = Math.min(40_000, Math.max(500, Number(args.max_chars) || 6000))
        let page
        try {
          page = await fetchText(url, {
            maxBytes: 3_000_000,
            timeoutMs: 15_000,
          })
        } catch (err) {
          return refuse(`Could not fetch that page: ${err?.message ?? err}.`)
        }
        let text = page.text
        if (page.type.includes('html')) {
          text = text
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
            .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)[^>]*>/gi, '\n')
            .replace(/<[^>]*>/g, ' ')
        }
        text = stripTags(text)
        // Paragraph breaks survive the strip; single newlines collapse.
        text = text
          .replace(/ {2,}/g, ' ')
          .replace(/\n\s*\n+/g, '\n\n')
          .trim()
        if (!text) return refuse('The page was empty.')
        const capped = text.slice(0, maxChars)
        return ok(
          `${page.url}\n\n${capped}` +
            (text.length > maxChars ? `\n\n[Truncated at ${maxChars} characters.]` : ''),
        )
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * The in-process tools keep the names the old MCP-in-process servers used —
 * `mcp__jarvis__display`, `mcp__jarvis_ui__ui_theme`, and so on. The permission
 * gate's server branches, the HUD's pretty tool names and the persona's own
 * references all read those shapes, so preserving them preserves every
 * downstream behaviour for free.
 */
const withPrefix = (prefix, defs) => defs.map((d) => ({ ...d, name: prefix + d.name }))

/**
 * @param {{
 *   allowWrites: boolean,
 *   ask: (kind: string, args?: object, timeoutMs?: number) => Promise<object>,
 *   emitBlade: (blade: object) => void,
 *   emitUi: (op: string, args: object) => void,
 * }} ctx
 */
export function createRegistry(ctx) {
  const defs = [
    ...builtinTools(),
    ...withPrefix('mcp__jarvis__', displayTools({ emitBlade: ctx.emitBlade })),
    ...withPrefix('mcp__jarvis_ui__', uiTools({ emit: ctx.emitUi })),
    ...withPrefix('mcp__jarvis_chrome__', chromeTools({ allowWrites: ctx.allowWrites })),
    ...withPrefix('mcp__jarvis_eyes__', visionTools({ ask: ctx.ask })),
  ]
  const byName = new Map(defs.map((d) => [d.name, d]))

  const registry = {
    defs,
    /** The wire format every OpenAI-compatible provider expects. */
    schemas: defs.map(toSchema),
    /** Server names for the HUD's SYSTEMS rail, in boot order. Display only —
     *  the tool prefixes above (mcp__jarvis__*) are what the permission gate
     *  and the persona's tool names match on, and those stay as they are. */
    serverNames: ['edith', 'edith_ui', 'edith_chrome', 'edith_eyes'],

    /** One tool call, routed and guarded. Never throws — a failure is a result. */
    async call(name, args) {
      const def = byName.get(name)
      if (!def) {
        return refuse(`No such tool: ${name}. It is not connected on this machine.`)
      }
      try {
        return await def.execute(args ?? {})
      } catch (err) {
        console.error(`[trinity] tool ${name} threw:`, err)
        return refuse(`The tool failed: ${err?.message ?? err}.`)
      }
    },

    /** Has a name, used by announceTool to skip refused-but-known tools. */
    has: (name) => byName.has(name),

    /** MCP tools join late (they start external processes), so a late add. */
    add(more) {
      for (const def of more) {
        if (byName.has(def.name)) continue
        byName.set(def.name, def)
        registry.defs.push(def)
        registry.schemas.push(toSchema(def))
        const server = def.name.split('__')[1]
        if (server && !registry.serverNames.includes(server)) {
          registry.serverNames.push(server)
        }
      }
    },
  }
  return registry
}

function toSchema(def) {
  return {
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters ?? { type: 'object', properties: {} },
    },
  }
}
