// Renders expressive-mode slides (Slide.html) to PNG via the SYSTEM Chrome (puppeteer-core, no bundled
// browser) so a reviewer model can SEE the deck. One lazy headless browser per process, fresh temp
// profile (never the user's real Chrome profiles), closed on exit. Per-slide failures are skipped.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import puppeteer, { type Browser } from 'puppeteer-core';
import type { Slide } from '../shared/types.js';
import { slideDoc } from '../web/src/lib/slideDoc.js';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TOTAL_CAP_MS = 25_000;

export interface SlideShot { id: string; title: string; pngBase64: string; n: number } // n = 1-based deck position
export type ImageBlock =
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } }
  | { type: 'text'; text: string };

let browserP: Promise<Browser> | null = null;
let profileDir: string | null = null;

function getBrowser(): Promise<Browser> {
  if (browserP) return browserP;
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dealdeck-shot-'));
  browserP = puppeteer
    .launch({
      executablePath: CHROME,
      headless: true,
      userDataDir: profileDir,
      args: ['--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio'],
    })
    .then((b) => {
      b.on('disconnected', () => { browserP = null; });
      return b;
    })
    .catch((e) => { browserP = null; throw e; });
  return browserP;
}

function cleanup() {
  const p = browserP;
  browserP = null;
  if (p) p.then((b) => b.process()?.kill()).catch(() => {});
  if (profileDir) try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
process.once('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { cleanup(); process.exit(0); });

async function shootOne(browser: Browser, slide: Slide, n: number, width: number, deadline: number): Promise<SlideShot | null> {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: width / 1920 });
    const left = Math.max(2000, Math.min(15_000, deadline - Date.now()));
    await page.setContent(slideDoc(slide.html!), { waitUntil: 'load', timeout: left });
    await page.waitForNetworkIdle({ idleTime: 250, timeout: Math.max(1000, deadline - Date.now()) }).catch(() => {});
    // Fonts settled, then freeze Chart.js at its final frame instead of waiting out the animation.
    await page.evaluate(async () => {
      try { await (document as any).fonts?.ready; } catch {}
      const C = (window as any).Chart;
      if (C?.instances) for (const c of Object.values<any>(C.instances)) { try { c.options.animation = false; c.update('none'); } catch {} }
    });
    await new Promise((r) => setTimeout(r, 150));
    const pngBase64 = (await page.screenshot({ type: 'png', encoding: 'base64' })) as string;
    return { id: slide.id, title: slide.title, pngBase64, n };
  } catch (e: any) {
    console.warn(`[screenshot] slide ${slide.id} skipped: ${e?.message || e}`);
    return null;
  } finally {
    page.close().catch(() => {});
  }
}

/** Screenshot every slide that has html (others are skipped). Default 960px wide PNGs, concurrency 4, ~25s cap. */
export async function screenshotSlides(slides: Slide[], opts?: { width?: number; concurrency?: number }): Promise<SlideShot[]> {
  const width = opts?.width ?? 960;
  const conc = Math.max(1, opts?.concurrency ?? 4);
  const todo = slides.map((s, i) => ({ s, i })).filter(({ s }) => typeof s.html === 'string' && s.html.trim());
  if (!todo.length) return [];
  let browser: Browser;
  try { browser = await getBrowser(); } catch (e: any) {
    console.warn(`[screenshot] chrome launch failed: ${e?.message || e}`);
    return [];
  }
  const deadline = Date.now() + TOTAL_CAP_MS;
  const out: Array<SlideShot | null> = new Array(todo.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < todo.length && Date.now() < deadline) {
      const k = next++;
      out[k] = await shootOne(browser, todo[k].s, todo[k].i + 1, width, deadline);
    }
  };
  const all = Promise.all(Array.from({ length: Math.min(conc, todo.length) }, worker));
  await Promise.race([all, new Promise((r) => setTimeout(r, TOTAL_CAP_MS + 2000))]);
  return out.filter((x): x is SlideShot => !!x);
}

/** Anthropic Messages user-content blocks: "Slide N: <title>" text, then the PNG, per shot. */
export function toImageBlocks(shots: SlideShot[]): ImageBlock[] {
  const blocks: ImageBlock[] = [];
  shots.forEach((s, i) => {
    blocks.push({ type: 'text', text: `Slide ${s.n ?? i + 1}: ${s.title}` });
    blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: s.pngBase64 } });
  });
  return blocks;
}
