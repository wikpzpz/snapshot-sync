import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { load } from 'cheerio/slim';
import type { HltvClient } from './client.ts';
import { clean, cleanName, imgUrl, pathOf, toInt } from './parse.ts';
import { coreCountry, parseRanking, parseTeamProfileHead } from './team.ts';
import type { MatchCard, TeamDirectoryEntry, TeamEvent, TeamRef } from './types.ts';

const FILE = '.cache/teams.json';
/** Committed seed, so a fresh CI checkout starts with the countries we know. */
const SEED_FILE = 'data/teams.json';

/** Team names are matched loosely: "BC.Game" and "bcgame" are the same team. */
export const teamKey = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The country a team is filed under: its roster core when known, else the
 * org/region label. Country views and country counts use this.
 */
export function homeCountry(team: TeamDirectoryEntry | null | undefined): string | null {
  if (!team) return null;
  return team.core ?? team.country ?? null;
}

export async function loadDirectory(): Promise<Record<string, TeamDirectoryEntry>> {
  for (const file of [FILE, SEED_FILE]) {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as Record<string, TeamDirectoryEntry>;
    } catch {
      // try the next one
    }
  }
  return {};
}

export async function saveDirectory(directory: Record<string, TeamDirectoryEntry>): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(directory, null, 2));
}

/** Absolute 30x20 flag derived from the 300x200 banner a match page uses. */
function flagUrl(src: string | undefined): string | null {
  if (!src) return null;
  const path = src.replace('/300x200/', '/30x20/').replace(/\.png$/i, '.gif');
  return `https://www.hltv.org${path}`;
}

/**
 * Both teams of https://www.hltv.org/matches/{id}/{slug}, with their region.
 *
 * The `teamsBox` carries a big region flag per team:
 * `<div class="team"><img alt="Europe" src="/img/static/flags/300x200/EU.png">…<div class="teamName">FaZe</div></div>`
 * Match cards on `/matches` do not include this, which is why the directory is
 * built from match pages and cached.
 */
export function parseMatchTeams(html: string): TeamDirectoryEntry[] {
  const $ = load(html);
  const teams: TeamDirectoryEntry[] = [];
  const seen = new Set<string>();

  $('.teamsBox .team').each((_, el) => {
    const node = $(el);
    const name = cleanName(node.find('.teamName').text()) ?? cleanName(node.find('img.logo').first().attr('alt'));
    if (!name || seen.has(teamKey(name))) return;
    seen.add(teamKey(name));
    const flag = node.find('img[src*="/flags/"]').first();
    const link = node.find('a[href*="/team/"]').first();
    const id = toInt(pathOf(link.attr('href')).match(/^\/team\/(\d+)\//)?.[1] ?? null);
    teams.push({
      name,
      country: clean(flag.attr('alt')),
      flag: flagUrl(flag.attr('src')),
      id,
      logo: imgUrl(node.find('img.logo').first().attr('src')),
    });
  });

  return teams;
}

/**
 * A match page's teams, retried with backoff.
 *
 * hltv.org answers fast bursts of match pages with a Cloudflare challenge again;
 * ~1 request/second keeps it at roughly 95% success, and the retries absorb the
 * rest (a miss is not fatal — the team is picked up on a later push).
 */
async function teamsOf(client: HltvClient, id: number): Promise<TeamDirectoryEntry[]> {
  let lastError: unknown = null;
  for (const [attempt, backoff] of [0, 1_500, 4_000].entries()) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, backoff));
    try {
      const teams = await client.getMatchTeams(id);
      if (teams.length) return teams;
    } catch (error) {
      lastError = error;
    }
  }
  return [];
}

export interface DirectoryResult {
  directory: Record<string, TeamDirectoryEntry>;
  /** Team entries learned during this call. */
  fetched: number;
  /** Teams still without a country (their match page was skipped or failed). */
  missing: string[];
}

/**
 * Add every team of `matches` to the cached directory.
 *
 * One match page covers two teams, so a first run over ~240 cards costs ~240
 * requests (~100 s, run in sequence to stay polite) and later runs only touch
 * matches that feature teams the cache has never seen.
 */
/** Anything with a match id and two teams — a match card or a result row. */
export interface DirectorySource {
  id: number;
  team1: { name?: string | null } | null;
  team2: { name?: string | null } | null;
}

export async function resolveDirectory(
  client: HltvClient,
  matches: DirectorySource[],
  options: { limit?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<DirectoryResult> {
  const directory = await loadDirectory();
  const wanted = new Map<string, string>();
  for (const match of matches) {
    for (const team of [match.team1, match.team2]) {
      if (team?.name) wanted.set(teamKey(team.name), team.name);
    }
  }

  const targets = matches
    .filter((match) => [match.team1, match.team2].some((team) => team?.name && !directory[teamKey(team.name)]))
    .slice(0, options.limit ?? 400);

  console.log(
    `  team directory: ${Object.keys(directory).length} known, ${targets.length}/${matches.length} matches to check`,
  );

  let fetched = 0;
  for (const [index, match] of targets.entries()) {
    try {
      for (const team of await teamsOf(client, match.id)) {
        directory[teamKey(team.name)] = team;
        fetched += 1;
      }
    } catch (error) {
      console.warn(`  country lookup failed for match ${match.id}: ${String(error).slice(0, 90)}`);
    }
    options.onProgress?.(index + 1, targets.length);
  }

  if (fetched) await saveDirectory(directory);

  const missing = [...wanted].filter(([key]) => !directory[key]).map(([, name]) => name);
  return { directory, fetched, missing };
}

/**
 * Tag a match with the countries of its teams.
 *
 * With `country`, `countryTeam` says which side is from that country
 * (`'team1'`, `'team2'`, `'both'`, or `null`), which is what a "Sweden" view
 * needs in order to highlight the Swedish team in `Drama vs LFO 10`.
 */
export function enrichMatch<T extends { team1: TeamRef | null; team2: TeamRef | null }>(
  match: T,
  directory: Record<string, TeamDirectoryEntry>,
  country?: string,
): T & { countryTeam?: 'team1' | 'team2' | 'both' | null } {
  const wanted = country?.trim().toLowerCase();
  const entryOf = (team: TeamRef | null): TeamDirectoryEntry | null =>
    team?.name ? directory[teamKey(team.name)] ?? null : null;
  const withCountry = (team: TeamRef | null): TeamRef | null =>
    team ? { ...team, country: homeCountry(entryOf(team)), flag: entryOf(team)?.flag ?? null } : null;

  const team1 = withCountry(match.team1);
  const team2 = withCountry(match.team2);
  if (!wanted) return { ...match, team1, team2 };

  const is1 = (team1?.country ?? '').toLowerCase() === wanted;
  const is2 = (team2?.country ?? '').toLowerCase() === wanted;
  return { ...match, team1, team2, countryTeam: is1 && is2 ? 'both' : is1 ? 'team1' : is2 ? 'team2' : null };
}

/**
 * Learn the country of every ranked team.
 *
 * The ranking page lists ~240 teams with ids but no country, and the country
 * only lives on each team page at ~74 KB of ~5 MB — so fetch a 200 KB prefix.
 * Teams already known are skipped, which makes later runs nearly free.
 */
export async function learnRankedTeams(
  client: HltvClient,
  options: { limit?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ added: number; missing: number }> {
  const ranking = parseRanking(await client.http.getHtml('/ranking/teams'));
  const directory = await loadDirectory();

  // Rosters come free with the ranking document, so every ranked team gets a
  // core nationality without a single extra request.
  for (const team of ranking) {
    const core = coreCountry(team.players);
    if (!core.size) continue;
    const key = teamKey(team.name);
    const existing = directory[key] ?? { name: team.name, country: null, flag: null };
    directory[key] = {
      ...existing,
      name: existing.name ?? team.name,
      core: core.country,
      coreCount: core.count,
      coreSize: core.size,
    };
  }

  // Persist the core data immediately: it costs no requests.
  await saveDirectory(directory);

  const pending = ranking
    .filter((team) => !directory[teamKey(team.name)]?.country)
    .slice(0, options.limit ?? 400);

  let added = 0;
  for (const [index, team] of pending.entries()) {
    try {
      const html = await client.http.getHtml(`/team/${team.id}/x`, { maxBytes: 200_000 });
      const head = parseTeamProfileHead(html);
      const key = teamKey(team.name);
      const existing = directory[key];
      directory[key] = {
        name: existing?.name ?? team.name,
        country: head.country ?? existing?.country ?? null,
        flag: head.flag ?? existing?.flag ?? null,
        id: team.id,
        logo: head.logo ?? existing?.logo ?? null,
      };
      added += 1;
    } catch (error) {
      console.warn(`  team lookup failed for ${team.name} (${team.id}): ${String(error).slice(0, 90)}`);
    }
    options.onProgress?.(index + 1, pending.length);
  }

  if (added) await saveDirectory(directory);
  const missing = ranking.filter((team) => !directory[teamKey(team.name)]?.country).length;
  return { added, missing };
}

/**
 * Learn teams from the attending-team lists on event pages.
 *
 * Ranking covers ~240 teams and matches/results cover the rest of the active
 * ones, but event pages list every invited team with its id — the widest
 * source HLTV exposes without login (its per-country stats pages are blocked).
 */
export async function learnEventTeams(
  client: HltvClient,
  options: { limit?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ added: number; known: number }> {
  const { ongoing, upcoming } = await client.getEvents();
  const events = [...ongoing, ...upcoming];
  const directory = await loadDirectory();
  const candidates = new Map<number, string>();

  for (const [index, event] of events.entries()) {
    try {
      const html = await client.http.getHtml(`/events/${event.id}/x`, { maxBytes: 250_000 });
      const $ = load(html);
      $('a[href*="/team/"]').each((_, el) => {
        const node = $(el);
        const href = pathOf(node.attr('href'));
        const id = toInt(href.match(/^\/team\/(\d+)\//)?.[1] ?? null);
        const name = cleanName(node.find('img').first().attr('alt')) ?? cleanName(node.text());
        if (id && name && !candidates.has(id)) candidates.set(id, name);
      });
    } catch (error) {
      console.warn(`  event ${event.id} failed: ${String(error).slice(0, 80)}`);
    }
    options.onProgress?.(index + 1, events.length);
  }

  const unknown = [...candidates]
    .filter(([, name]) => !directory[teamKey(name)]?.country)
    .slice(0, options.limit ?? 300);

  let added = 0;
  for (const [id, name] of unknown) {
    try {
      const head = parseTeamProfileHead(await client.http.getHtml(`/team/${id}/x`, { maxBytes: 200_000 }));
      const key = teamKey(name);
      const existing = directory[key];
      directory[key] = {
        name: existing?.name ?? name,
        country: head.country ?? existing?.country ?? null,
        flag: head.flag ?? existing?.flag ?? null,
        id,
        logo: head.logo ?? existing?.logo ?? null,
      };
      added += 1;
      // Save as we go: a long crawl can be interrupted without losing progress.
      if (added % 40 === 0) await saveDirectory(directory);
    } catch (error) {
      console.warn(`  team ${name} (${id}) failed: ${String(error).slice(0, 80)}`);
    }
  }

  if (added) await saveDirectory(directory);
  return { added, known: candidates.size };
}

export interface CountryHit {
  name: string;
  teams: number;
  flag: string | null;
}

/** Countries in the directory whose name matches `query` (e.g. "swe" → Sweden). */
export function searchCountries(
  directory: Record<string, TeamDirectoryEntry>,
  query: string,
): CountryHit[] {
  const wanted = query.trim().toLowerCase();
  if (wanted.length < 3) return [];

  const hits = new Map<string, CountryHit>();
  for (const team of Object.values(directory)) {
    const country = (homeCountry(team) ?? '').trim();
    const key = country.toLowerCase();
    if (!country || key === 'other' || key === 'world' || !key.includes(wanted)) continue;
    const hit = hits.get(key) ?? { name: country, teams: 0, flag: team.flag ?? null };
    hit.teams += 1;
    if (!hit.flag && team.flag) hit.flag = team.flag;
    hits.set(key, hit);
  }

  return [...hits.values()].sort((a, b) => b.teams - a.teams).slice(0, 4);
}

export interface CountryView {
  team: { id: number; name: string; url: null; logo: null; country: string; flag: string | null };
  upcoming: MatchCard[];
  events: TeamEvent[];
  teams: string[];
}

/** Every upcoming/live match of the teams that `country` claims, plus their events. */
export function countryView(
  country: string,
  matches: MatchCard[],
  directory: Record<string, TeamDirectoryEntry>,
): CountryView {
  const wanted = country.trim().toLowerCase();
  const countryOf = (name: string | null | undefined): string | null =>
    name ? homeCountry(directory[teamKey(name)])?.toLowerCase() ?? null : null;

  const upcoming = matches
    .filter((match) => countryOf(match.team1?.name) === wanted || countryOf(match.team2?.name) === wanted)
    .map((match) => enrichMatch(match, directory, country))
    .sort((a, b) => (a.startsAt ?? 0) - (b.startsAt ?? 0));

  const members = Object.values(directory).filter((team) => (homeCountry(team) ?? '').toLowerCase() === wanted);

  const events = new Map<string, TeamEvent>();
  for (const match of upcoming) {
    if (!match.event?.name) continue;
    const eventKey = String(match.event.id ?? match.event.name);
    if (events.has(eventKey)) continue;
    events.set(eventKey, {
      id: match.event.id ?? 0,
      url: match.event.id ? `https://www.hltv.org/events/${match.event.id}/x` : '',
      name: match.event.name,
      logo: match.event.logo ?? null,
      startsAt: null,
      endsAt: null,
    });
  }

  return {
    team: {
      id: 0,
      name: members[0]?.country ?? country,
      url: null,
      logo: null,
      country: `${members.length} teams`,
      flag: members.find((team) => team.flag)?.flag ?? null,
    },
    upcoming,
    events: [...events.values()],
    teams: members.map((team) => team.name),
  };
}
