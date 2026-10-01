// Web fallback tools: DuckDuckGo HTML search + page fetch/strip. Both write receipts (source 'web').
import { addReceipt } from './store.js';
import type { ToolDef } from './tooling.js';
import { BROWSER_UA } from './dealroom.js';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#x2F': '/' };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
    if (ENTITIES[e] !== undefined) return ENTITIES[e];
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return m;
  });
}
const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

/** DuckDuckGo wraps result links as //duckduckgo.com/l/?uddg=<encoded target>. */
function unwrapDdg(href: string): string {
  const h = decodeEntities(href);
  try {
    const u = new URL(h.startsWith('//') ? `https:${h}` : h, 'https://duckduckgo.com');
    const target = u.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : u.toString();
  } catch { return h; }
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const webTools: ToolDef[] = [
  {
    name: 'web_search',
    description: 'Search the public web (DuckDuckGo). Returns the top 8 results (title, url, snippet). Use for facts Dealroom lacks: recent news, press releases, revenue claims, product launches.',
    input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    async run(input, ctx) {
      const q = String(input.q);
      ctx.status(`Searching the web for "${q}"...`);
      const t0 = Date.now();
      // Node's fetch gets a 403 from DDG on POST (measured; curl's POST passes), while GET returns results. Try GET, fall back to POST.
      let res = await fetch(`https://html.duckduckgo.com/html/?${new URLSearchParams({ q })}`, { headers: { 'user-agent': BROWSER_UA, accept: '*/*' }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) {
        res = await fetch('https://html.duckduckgo.com/html/', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': BROWSER_UA, accept: '*/*' },
          body: new URLSearchParams({ q }).toString(),
          signal: AbortSignal.timeout(20_000),
        });
      }
      const html = await res.text();
      const results: Array<{ title: string; url: string; snippet: string }> = [];
      const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1);
      for (const b of blocks) {
        if (/result--ad\b/.test(b.slice(0, 200))) continue;
        const a = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(b);
        if (!a) continue;
        const sn = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i.exec(b);
        const url = unwrapDdg(a[1]);
        if (/duckduckgo\.com\/y\.js/.test(url)) continue; // sponsored
        results.push({ title: stripTags(a[2]), url, snippet: sn ? stripTags(sn[1]) : '' });
        if (results.length >= 8) break;
      }
      const ms = Date.now() - t0;
      const r = addReceipt(ctx.session, { source: 'web', endpoint: 'https://html.duckduckgo.com/html/', params: { q }, status: res.status, ms, json: { results } });
      if (!res.ok) return { receipt: r.id, status: res.status, error: `web search failed: HTTP ${res.status}` };
      return { receipt: r.id, data: results };
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a web page and return its readable text (scripts/styles/tags stripped, max 12000 chars). Use on URLs from web_search or company websites.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    async run(input, ctx) {
      let url = String(input.url).trim();
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      ctx.status(`Reading ${new URL(url).hostname}...`);
      const t0 = Date.now();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 20000);
      let res: Response;
      let raw: string;
      try {
        res = await fetch(url, { redirect: 'follow', signal: ac.signal, headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'accept-language': 'en-GB,en;q=0.9' } });
        raw = await res.text(); // inside the timeout: a slow/endless body must not wedge the turn
      } finally { clearTimeout(timer); }
      const ctype = res.headers.get('content-type') ?? '';
      const text = (/html|xml/i.test(ctype) || /^\s*</.test(raw) ? htmlToText(raw) : raw.replace(/\s+/g, ' ').trim()).slice(0, 12000);
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1];
      const ms = Date.now() - t0;
      const r = addReceipt(ctx.session, { source: 'web', endpoint: res.url || url, params: { url }, status: res.status, ms, json: { title: title ? stripTags(title) : null, text } });
      return { receipt: r.id, status: res.status, title: title ? stripTags(title) : null, text };
    },
  },
];
