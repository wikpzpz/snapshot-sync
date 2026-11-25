// Diagnostic: can this machine load a /stats/matches/mapstatsid/ page?
// Usage: node scripts/probe-stats.mjs <mapStatsId>
// Runs curl-impersonate profiles first, then headful Chromium (needs a display,
// e.g. `xvfb-run -a` on CI).
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

const id = process.argv[2] ?? '245031';
const url = `https://www.hltv.org/stats/matches/mapstatsid/${id}/x`;
const binary = process.env.CURL_BIN ?? '.tools/curl-impersonate';

const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({ error, stdout, stderr }),
    );
  });

const report = (label, html, status) => {
  const challenge = /Just a moment|cf-chl|challenge-platform/i.test(html.slice(0, 4000));
  const rows = (html.match(/class="st-player"/g) ?? []).length;
  console.log(
    `${label}: HTTP ${status} bytes=${html.length} challenge=${challenge} playerRows=${rows}`,
  );
};

for (const profile of ['chrome116', 'chrome131']) {
  const { error, stdout, stderr } = await run(binary, [
    '--impersonate',
    profile,
    '-sS',
    '-w',
    '\n__STATUS__%{http_code}',
    url,
  ]);
  if (error) {
    console.log(`curl ${profile}: failed ${String(stderr).slice(0, 200)}`);
    continue;
  }
  const marker = stdout.lastIndexOf('\n__STATUS__');
  report(`curl ${profile}`, stdout.slice(0, marker), stdout.slice(marker + 11).trim());
}

try {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'Europe/Stockholm',
  });
  await page.goto('https://www.hltv.org/matches', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(4000);
  console.log('warm-up /matches title:', await page.title());
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(5000);
  report('headful chromium', await page.content(), response?.status() ?? '?');
  await browser.close();
} catch (error) {
  console.log('browser probe failed:', String(error).slice(0, 300));
}
