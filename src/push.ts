/**
 * Scrape locally (curl-impersonate works here) and push the parsed JSON to the
 * hosted the API on Freebuff Sites, which stores it in D1 and serves it.
 *
 *   npm run push                one push
 *   npm run push:watch          every 5 minutes
 *   node --experimental-strip-types src/push.ts --watch 2
 *
 * Env:
 *   SITE_URL   default https://the API-461yz8-preview.freebuff.site
 *   PUSH_KEY   defaults to the contents of .secrets/push-key
 */
import { readFile } from 'node:fs/promises';
import { FeedClient } from './client.ts';
import { learnRankedTeams, loadDirectory, resolveDirectory } from './directory.ts';
import type { MatchCard } from './types.ts';

const SITE_URL = (process.env.SITE_URL ?? 'https://cs2api-461yz8-preview.freebuff.site').replace(/\/$/, '');

async function pushKey(): Promise<string> {
  if (process.env.PUSH_KEY) return process.env.PUSH_KEY.trim();
  try {
    return (await readFile('.secrets/push-key', 'utf8')).trim();
  } catch {
    throw new Error('No push key: set PUSH_KEY or create .secrets/push-key');
  }
}

/** How many match pages one run is allowed to open (each is ~500 KB). */
const DETAIL_LIMIT = 25;

/**
 * Match pages to scrape: the ones a client asked the API for (the queue it fills
 * on /api/match/:id) plus every live match, so a live scoreboard also has its
 * veto and player stats.
 */
async function detailIds(matches: MatchCard[]): Promise<number[]> {
  const live = matches.filter((match) => match.status === 'live').map((match) => match.id);

  let queued: number[] = [];
  try {
    const res = await fetch(`${SITE_URL}/api/detail-queue?limit=${DETAIL_LIMIT}`, {
      headers: { 'x-push-key': await pushKey() },
    });
    if (res.ok) queued = ((await res.json()) as { ids?: number[] }).ids ?? [];
    else console.warn(`  detail queue: HTTP ${res.status}`);
  } catch (error) {
    console.warn(`  detail queue unavailable: ${String(error).slice(0, 80)}`);
  }

  return [...new Set([...queued, ...live])].slice(0, DETAIL_LIMIT);
}

/** Scrape the requested match pages and store them next to the snapshots. */
async function pushDetails(client: FeedClient, matches: MatchCard[]): Promise<void> {
  const ids = await detailIds(matches);
  if (!ids.length) return;

  const details = [];
  for (const id of ids) {
    try {
      details.push(await client.getMatch(id));
    } catch (error) {
      console.warn(`  match ${id} details failed: ${String(error).slice(0, 80)}`);
    }
  }
  if (!details.length) return;

  const res = await fetch(`${SITE_URL}/api/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-push-key': await pushKey() },
    body: JSON.stringify({ details }),
  });
  const body = (await res.json().catch(() => ({}))) as { stored?: string[]; error?: string };
  if (!res.ok) {
    console.warn(`  detail push failed (HTTP ${res.status}): ${body.error ?? 'unknown error'}`);
    return;
  }
  console.log(`  match details: ${details.length} pushed (${(body.stored ?? []).join(', ')})`);
}

async function runOnce(): Promise<void> {
  const started = Date.now();
  // ~1 request/second: match pages get Cloudflare-challenged when requested faster.
  const client = new FeedClient({ delayMs: 900 });
  try {
    console.log(`Scraping with transport: ${client.http.transport}`);

    const matches = await client.getMatches();
    console.log(`  matches: ${matches.length}`);

    const { ongoing, upcoming } = await client.getEvents();
    console.log(`  events: ${ongoing.length + upcoming.length} (${ongoing.length} ongoing, ${upcoming.length} upcoming)`);

    // Four pages of results ≈ the last few days, so the API can answer
    // "what did this team play in the last 3 days".
    const results = [];
    for (const offset of [0, 100, 200, 300]) {
      try {
        const page = await client.getResults({ offset });
        if (!page.length) break;
        results.push(...page);
      } catch (error) {
        console.warn(`  results page ${offset} failed: ${String(error).slice(0, 80)}`);
      }
    }
    console.log(`  results: ${results.length}`);

    // One match page covers two teams' countries; only unknown teams are fetched.
    // Finished results are included because many upcoming cards are still TBD.
    const { fetched, missing } = await resolveDirectory(client, [...matches, ...results], {
      // Learned teams are cached, so a capped run simply continues next time.
      limit: 150,
      onProgress: (done, total) => {
        if (done % 25 === 0 || done === total) console.log(`  team countries: ${done}/${total} match pages`);
      },
    });
    // Every ranked team gets a country too, so a country view is not limited to
    // the teams that happen to have a fixture right now.
    const ranked = await learnRankedTeams(client, { limit: 40 });
    if (ranked.added) console.log(`  ranked teams: +${ranked.added} (${ranked.missing} still unknown)`);

    const teams = Object.values(await loadDirectory());
    console.log(`  teams: ${teams.length} known (${fetched} new)`);
    if (missing.length) console.log(`  ! no country yet for ${missing.length} teams (they fill in on later pushes)`);

    const res = await fetch(`${SITE_URL}/api/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-push-key': await pushKey() },
      body: JSON.stringify({ matches, events: [...ongoing, ...upcoming], results, teams, pushedAt: Date.now() }),
    });

    const body = (await res.json().catch(() => ({}))) as { error?: string; stored?: string[] };
    if (!res.ok) throw new Error(`push failed (HTTP ${res.status}): ${body.error ?? 'unknown error'}`);

    console.log(`Pushed to ${SITE_URL} in ${((Date.now() - started) / 1000).toFixed(1)}s: ${(body.stored ?? []).join(', ')}`);

    await pushDetails(client, matches);
  } finally {
    await client.close();
  }
}

const watchIndex = process.argv.indexOf('--watch');
const minutes = watchIndex > -1 ? Number(process.argv[watchIndex + 1] ?? 5) : 0;

if (minutes > 0) {
  console.log(`Watching: pushing every ${minutes} minute(s). Ctrl+C to stop.`);
  for (;;) {
    try {
      await runOnce();
    } catch (error) {
      console.error(`push failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log(`Next push in ${minutes} minute(s).`);
    await new Promise((resolve) => setTimeout(resolve, minutes * 60_000));
  }
} else {
  await runOnce();
}
