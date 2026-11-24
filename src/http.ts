import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { curlFetch, resolveCurlBinary, DEFAULT_PROFILES } from './curl.ts';

export const BASE_URL = 'https://www.hltv.org';

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CHALLENGE = /Just a moment|cf-chl|challenge-platform|Enable JavaScript and cookies to continue/i;

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface HttpClientOptions {
  /**
   * - `auto` (default): `curl` when curl-impersonate is installed, else `browser`.
   * - `curl`: plain HTTP with Chrome's TLS fingerprint — no browser, no window.
   * - `browser`: drives real Chrome (needs a browser process; headless is often challenged).
   * - `fetch`: plain node HTTP, only works with a valid `cf_clearance` cookie.
   */
  mode?: 'auto' | 'curl' | 'browser' | 'fetch';
  /** Explicit curl-impersonate binary path (default: `.tools/curl-impersonate`). */
  curlPath?: string;
  /** Impersonation profile(s) for the curl transport. Default `chrome131`. */
  impersonate?: string | string[];
  /** Raw `Cookie:` header value used by the `fetch` transport. */
  cookie?: string;
  /** Run Chrome headless in `browser` mode. Default true, with headful fallback. */
  headless?: boolean;
  /** When headless Chrome is challenged, relaunch visibly and retry. Default true. */
  allowHeadfulFallback?: boolean;
  /** Explicit Chrome/Chromium executable for `browser` mode. */
  executablePath?: string;
  /** Optional Chrome profile dir (off by default; stale clearance cookies get rejected). */
  profileDir?: string | false;
  timeoutMs?: number;
  /** Politeness delay between requests. Default 200ms. */
  delayMs?: number;
  userAgent?: string;
}

/**
 * Serialized HTTP layer for hltv.org.
 *
 * hltv.org has no JSON API: every page is a Cloudflare-protected HTML document.
 * Measured behaviour that shaped this class:
 * - Plain node/curl requests get `403 Just a moment...` — Cloudflare scores the
 *   TLS/HTTP2 fingerprint, not just headers.
 * - curl-impersonate with `--impersonate chrome131` gets `200` on every page,
 *   with no browser process at all (that is the default transport).
 * - `chrome136` is rejected, so the profile matters and is configurable.
 * - Headless Chrome is challenged; a real window passes. The browser fallback
 *   uses a fresh context per request, which measured clean, and auto-switches
 *   from headless to headful when blocked.
 */
export class HltvHttp {
  private readonly opts: Required<
    Omit<HttpClientOptions, 'cookie' | 'executablePath' | 'profileDir' | 'curlPath'>
  > &
    Pick<HttpClientOptions, 'cookie' | 'executablePath' | 'profileDir' | 'curlPath'>;
  private readonly mode: 'curl' | 'browser' | 'fetch';
  private browser: Browser | null = null;
  private headless: boolean;
  private queue: Promise<unknown> = Promise.resolve();
  /** Number of network requests performed, useful for debugging. */
  requests = 0;

  constructor(options: HttpClientOptions = {}) {
    this.opts = {
      mode: options.mode ?? 'auto',
      // Try the whole profile list by default: which fingerprint Cloudflare
      // accepts depends on the network the request comes from (a residential
      // IP likes chrome131, a GitHub runner may not).
      impersonate: options.impersonate ?? DEFAULT_PROFILES,
      headless: options.headless ?? true,
      allowHeadfulFallback: options.allowHeadfulFallback ?? true,
      timeoutMs: options.timeoutMs ?? 30_000,
      delayMs: options.delayMs ?? 200,
      userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
      cookie: options.cookie,
      executablePath: options.executablePath,
      curlPath: options.curlPath,
      profileDir: options.profileDir ?? false,
    };
    this.headless = this.opts.headless;

    const requested = options.mode ?? 'auto';
    this.mode =
      requested === 'auto' ? (resolveCurlBinary(options.curlPath) ? 'curl' : 'browser') : requested;
  }

  /** Resolve a path or absolute URL against hltv.org. */
  static resolve(pathOrUrl: string): string {
    return /^https?:\/\//i.test(pathOrUrl)
      ? pathOrUrl
      : BASE_URL + (pathOrUrl.startsWith('/') ? pathOrUrl : '/' + pathOrUrl);
  }

  /** Which transport this client settled on: `curl`, `browser` or `fetch`. */
  get transport(): 'curl' | 'browser' | 'fetch' {
    return this.mode;
  }

  /** Fetch HTML, serialized through a single queue. */
  getHtml(pathOrUrl: string): Promise<string> {
    const url = HltvHttp.resolve(pathOrUrl);
    const run = this.queue.then(() => this.perform(url));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async perform(url: string): Promise<string> {
    this.requests += 1;
    if (this.mode === 'fetch') return this.fetchHtml(url);
    if (this.mode === 'curl') return this.curlHtml(url);
    return this.browserHtml(url);
  }

  private async curlHtml(url: string): Promise<string> {
    const binary = resolveCurlBinary(this.opts.curlPath);
    if (!binary) {
      throw new Error('curl-impersonate not found; run `npm run setup:curl` or use mode "browser".');
    }
    const html = await curlFetch(url, {
      binary,
      timeoutMs: this.opts.timeoutMs,
      impersonate: this.opts.impersonate,
    });
    if (this.opts.delayMs > 0) await sleep(this.opts.delayMs);
    return html;
  }

  private async fetchHtml(url: string): Promise<string> {
    const headers: Record<string, string> = {
      'user-agent': this.opts.userAgent,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'upgrade-insecure-requests': '1',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
    };
    if (this.opts.cookie) headers.cookie = this.opts.cookie;

    const res = await fetch(url, { headers, redirect: 'follow' });
    const body = await res.text();
    if (res.status === 403 || CHALLENGE.test(body.slice(0, 4000))) {
      throw new Error(
        `Blocked by Cloudflare (HTTP ${res.status}) for ${url}. ` +
          'Use the curl transport, or supply a fresh cf_clearance cookie.',
      );
    }
    if (!res.ok) throw new Error(`HLTV responded HTTP ${res.status} for ${url}`);
    return body;
  }

  private contextOptions() {
    return {
      userAgent: this.opts.userAgent,
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'Europe/Stockholm',
    };
  }

  private launchCandidates(): Array<Record<string, unknown>> {
    const candidates: Array<Record<string, unknown>> = [];
    if (this.opts.executablePath) candidates.push({ executablePath: this.opts.executablePath });
    candidates.push({ channel: 'chrome' });
    for (const path of CHROME_CANDIDATES) candidates.push({ executablePath: path });
    candidates.push({});
    return candidates;
  }

  private launchArgs(): Record<string, unknown> {
    return {
      headless: this.headless,
      args: ['--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation'],
    };
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    let lastError: unknown = null;
    for (const candidate of this.launchCandidates()) {
      try {
        this.browser = await chromium.launch({ ...candidate, ...this.launchArgs() });
        return this.browser;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(
      'No Chrome/Chromium executable found for the browser transport. Install Google Chrome, ' +
        'run `npx playwright install chromium`, or pass executablePath. Last error: ' +
        String(lastError),
    );
  }

  /** A fresh context per request is what keeps the Cloudflare challenges away. */
  private async openPage(): Promise<{ page: Page; dispose: () => Promise<void> }> {
    if (this.opts.profileDir) {
      let context: BrowserContext | null = null;
      let lastError: unknown = null;
      for (const candidate of this.launchCandidates()) {
        try {
          context = await chromium.launchPersistentContext(String(this.opts.profileDir), {
            ...candidate,
            ...this.launchArgs(),
            ...this.contextOptions(),
          });
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!context) throw lastError instanceof Error ? lastError : new Error(String(lastError));
      await context.clearCookies();
      const page = await context.newPage();
      return {
        page,
        dispose: async () => {
          await page.close().catch(() => undefined);
          await context?.close().catch(() => undefined);
        },
      };
    }

    const browser = await this.ensureBrowser();
    const context = await browser.newContext(this.contextOptions());
    const page = await context.newPage();
    return { page, dispose: () => context.close().catch(() => undefined) };
  }

  /** Poll until the Cloudflare interstitial is gone. */
  private async waitForContent(page: Page, url: string): Promise<string | null> {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const html = await page.content().catch(() => null);
      if (html && !CHALLENGE.test(html.slice(0, 4000))) return html;
      await sleep(600);
    }
    console.warn(`[hltv] Cloudflare still challenging ${url}`);
    return null;
  }

  private async loadOnce(url: string): Promise<string> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const { page, dispose } = await this.openPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.opts.timeoutMs });
        const html = await this.waitForContent(page, url);
        if (html) {
          if (this.opts.delayMs > 0) await sleep(this.opts.delayMs);
          return html;
        }
      } finally {
        await dispose();
      }
      await sleep(700 * attempt);
    }
    throw new Error(`Cloudflare challenge did not clear for ${url}`);
  }

  private async browserHtml(url: string): Promise<string> {
    try {
      return await this.loadOnce(url);
    } catch (error) {
      if (!this.headless || !this.opts.allowHeadfulFallback) throw error;
      console.warn('[hltv] headless was blocked, retrying with a visible Chrome window');
      this.headless = false;
      await this.resetBrowser();
      return this.loadOnce(url);
    }
  }

  private async resetBrowser(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }

  async close(): Promise<void> {
    await this.resetBrowser();
  }
}
