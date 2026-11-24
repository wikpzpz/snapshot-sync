import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CHALLENGE = /Just a moment|cf-chl|challenge-platform|Enable JavaScript and cookies to continue/i;

/**
 * Impersonation profiles tried in order.
 *
 * Measured against hltv.org: `chrome131` gets `200` on every page, while
 * `chrome136` is answered with `403 Just a moment...`. Cloudflare scores the TLS
 * ClientHello + HTTP/2 fingerprint, so the profile matters more than the headers.
 */
export const DEFAULT_PROFILES = ['chrome131', 'chrome124', 'chrome120'];

const CANDIDATE_PATHS = [
  join('.tools', 'curl-impersonate.exe'),
  join('.tools', 'curl-impersonate'),
  '/usr/local/bin/curl-impersonate',
  '/opt/homebrew/bin/curl-impersonate',
  '/usr/bin/curl-impersonate',
];

/** Locate a curl-impersonate binary, or null when none is installed. */
export function resolveCurlBinary(explicit?: string): string | null {
  if (explicit) return existsSync(explicit) ? explicit : null;
  if (process.env.HLTV_CURL_PATH && existsSync(process.env.HLTV_CURL_PATH)) {
    return process.env.HLTV_CURL_PATH;
  }
  for (const candidate of CANDIDATE_PATHS) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface CurlFetchOptions {
  binary: string;
  timeoutMs?: number;
  /** One profile or an ordered list to try when Cloudflare rejects one. */
  impersonate?: string | string[];
}

/**
 * Fetch a page through curl-impersonate.
 *
 * This is a real HTTP request with Chrome's TLS/HTTP2 fingerprint — no browser
 * process, no window — which is what hltv.org's Cloudflare rule accepts.
 */
export async function curlFetch(url: string, options: CurlFetchOptions): Promise<string> {
  const profiles = Array.isArray(options.impersonate)
    ? options.impersonate
    : options.impersonate
      ? [options.impersonate]
      : DEFAULT_PROFILES;
  const timeoutMs = options.timeoutMs ?? 30_000;

  let lastBody = '';
  let lastError: unknown = null;

  for (const profile of profiles) {
    const args = [
      '--impersonate',
      profile,
      '--compressed',
      '-sS',
      '-L',
      '--max-time',
      String(Math.ceil(timeoutMs / 1000)),
      url,
    ];
    try {
      const { stdout } = await execFileAsync(options.binary, args, {
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs + 5_000,
        windowsHide: true,
        encoding: 'utf8',
      });
      lastBody = stdout;
      if (stdout.length > 0 && !CHALLENGE.test(stdout.slice(0, 4000))) return stdout;
      console.warn(`[hltv] profile ${profile} was challenged for ${url}`);
    } catch (error) {
      lastError = error;
      console.warn(`[hltv] profile ${profile} failed for ${url}: ${String(error).slice(0, 120)}`);
    }
  }

  if (lastBody.length === 0 && lastError) {
    throw new Error(`curl-impersonate failed for ${url}: ${String(lastError).slice(0, 200)}`);
  }
  throw new Error(
    `Cloudflare rejected every impersonation profile (${profiles.join(', ')}) for ${url}. ` +
      'Try another profile, or fall back to mode "browser".',
  );
}
