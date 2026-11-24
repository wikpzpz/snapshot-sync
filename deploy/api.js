/**
 * the API on Freebuff Sites (Cloudflare Workers) — snapshot mode.
 *
 * A Worker cannot run curl-impersonate, its own fetch() to the source site gets
 * `403 Just a moment...`, and every free keyless renderer (r.jina.ai, microlink)
 * rate-limits Cloudflare's shared egress IPs with `429`. So the hosted API does
 * not scrape at all: `npm run push` scrapes locally (where curl-impersonate works
 * reliably) and POSTs the parsed JSON here, and these endpoints serve it from D1.
 *
 * No API keys, no third-party quota — only the push key that guards writes.
 *
 * Routes:
 *   GET  /api/meta                 snapshot freshness + counts
 *   GET  /api/matches              live + upcoming matches
 *   GET  /api/results?offset=      finished matches
 *   GET  /api/events               ongoing + upcoming events
 *   GET  /api/search?q=            teams and countries found in the snapshot
 *   GET  /api/team/:id?name=NAME   a team's upcoming matches + events
 *   GET  /api/country/:name        every upcoming match of that country's teams
 *   GET  /api/country/:name/results results row: finished matches, last `days` days
 *   POST /api/push                 replace snapshots (header: x-push-key)
 *   POST /api/refresh?key=         start the snapshot job (header x-refresh-key)
 */
const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-push-key',
  'x-robots-tag': 'noindex, nofollow, noarchive',
  'cache-control': 'public, max-age=60',
};

const NO_STORE = { ...HEADERS, 'cache-control': 'no-store' };

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: status >= 400 ? NO_STORE : HEADERS,
  });
}

let schemaReady = false;

async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS snapshots (kind TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)',
  ).run();
  schemaReady = true;
}

async function readSnapshot(env, kind) {
  await ensureSchema(env);
  const row = await env.DB.prepare('SELECT payload, updated_at FROM snapshots WHERE kind = ?')
    .bind(kind)
    .first();
  if (!row) return null;
  return { data: JSON.parse(row.payload), updatedAt: row.updated_at };
}

async function writeSnapshot(env, kind, data) {
  await ensureSchema(env);
  await env.DB.prepare(
    'INSERT INTO snapshots (kind, payload, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at',
  )
    .bind(kind, JSON.stringify(data), Date.now())
    .run();
}

const norm = (value) => String(value ?? '').toLowerCase().trim();

/** Team names are matched loosely: "BC.Game" and "bcgame" are the same team. */
const teamKey = (name) => norm(name).replace(/[^a-z0-9]/g, '');

/** Roster core first, then the org/region label the source prints. */
const homeCountry = (team) => (team ? team.core || team.country || null : null);

/** name key -> team directory entry ({ name, country, flag }). */
function teamIndex(teams) {
  const index = new Map();
  for (const team of teams ?? []) {
    if (team && team.name) index.set(teamKey(team.name), team);
  }
  return index;
}

/**
 * Stamp both teams with their country/flag, and with `country` say which side is
 * from that country (`countryTeam`: 'team1' | 'team2' | 'both' | null).
 */
function enrichMatch(match, index, country) {
  const entryOf = (team) => (team && team.name ? index.get(teamKey(team.name)) ?? null : null);
  const withCountry = (team) =>
    team ? { ...team, country: homeCountry(entryOf(team)), flag: entryOf(team)?.flag ?? null } : null;

  const team1 = withCountry(match.team1);
  const team2 = withCountry(match.team2);
  if (!country) return { ...match, team1, team2 };

  const wanted = norm(country);
  const is1 = norm(team1?.country) === wanted;
  const is2 = norm(team2?.country) === wanted;
  return { ...match, team1, team2, countryTeam: is1 && is2 ? 'both' : is1 ? 'team1' : is2 ? 'team2' : null };
}

/** Unique team names found anywhere in the snapshots. */
function collectTeams(matches, events) {
  const names = new Map();
  const add = (name, logo) => {
    const key = norm(name);
    if (!key) return;
    const existing = names.get(key);
    if (existing) {
      if (!existing.logo && logo) existing.logo = logo;
      return;
    }
    names.set(key, { id: 0, name, url: null, logo: logo ?? null });
  };

  for (const match of matches ?? []) {
    add(match.team1?.name, match.team1?.logo);
    add(match.team2?.name, match.team2?.logo);
  }
  for (const event of events ?? []) {
    for (const team of event.teams ?? []) add(team, null);
  }
  return Array.from(names.values());
}

/** Team view derived from the pushed matches/events — no team page needed. */
function teamView(name, matches, events) {
  const wanted = norm(name);
  const mine = (matches ?? []).filter(
    (match) => norm(match.team1?.name) === wanted || norm(match.team2?.name) === wanted,
  );

  const logo =
    mine.find((match) => norm(match.team1?.name) === wanted)?.team1?.logo ??
    mine.find((match) => norm(match.team2?.name) === wanted)?.team2?.logo ??
    null;

  const uniqueEvents = new Map();
  for (const match of mine) {
    if (!match.event?.name) continue;
    const key = match.event.id != null ? `id:${match.event.id}` : `name:${norm(match.event.name)}`;
    if (!uniqueEvents.has(key)) {
      uniqueEvents.set(key, {
        id: match.event.id ?? null,
        name: match.event.name,
        url: match.event.id != null ? `https://www.hltv.org/events/${match.event.id}/x` : null,
        logo: match.event.logo ?? null,
        startsAt: null,
        endsAt: null,
        matches: 0,
      });
    }
    uniqueEvents.get(key).matches += 1;
  }

  // Fall back to the events snapshot for dates when the team has no fixtures.
  for (const event of events ?? []) {
    const key = event.id != null ? `id:${event.id}` : null;
    if (!key || !uniqueEvents.has(key)) continue;
    uniqueEvents.set(key, { ...uniqueEvents.get(key), startsAt: event.startsAt ?? null, endsAt: event.endsAt ?? null });
  }

  // The snapshot has no team page, but match cards carry real team ids.
  let teamId = null;
  for (const match of mine) {
    if (norm(match.team1?.name) === wanted && match.team1?.id != null) {
      teamId = match.team1.id;
      break;
    }
    if (norm(match.team2?.name) === wanted && match.team2?.id != null) {
      teamId = match.team2.id;
      break;
    }
  }

  return {
    team: {
      id: teamId ?? 0,
      name,
      url: teamId ? `https://www.hltv.org/team/${teamId}/x` : null,
      logo,
      country: null,
      flag: null,
    },
    upcoming: mine.sort((a, b) => (a.startsAt ?? 0) - (b.startsAt ?? 0)),
    events: Array.from(uniqueEvents.values()),
  };
}

/** Countries whose name matches `query` ("swe" → Sweden), with team counts. */
function searchCountries(teams, query) {
  const wanted = norm(query);
  if (!wanted || wanted.length < 3) return [];
  const hits = new Map();
  for (const team of teams ?? []) {
    const country = String(homeCountry(team) ?? '').trim();
    const key = norm(country);
    if (!country || key === 'other' || key === 'world' || !key.includes(wanted)) continue;
    const hit = hits.get(key) ?? { name: country, teams: 0, flag: team.flag ?? null };
    hit.teams += 1;
    if (!hit.flag && team.flag) hit.flag = team.flag;
    hits.set(key, hit);
  }
  return [...hits.values()].sort((a, b) => b.teams - a.teams).slice(0, 4);
}

/** Days of finished matches a country result row covers (clamped to 0–30). */
function resultDays(raw) {
  if (raw == null || raw === '') return 3;
  const days = Number(raw);
  if (!Number.isFinite(days)) return 3;
  return Math.max(0, Math.min(30, Math.trunc(days)));
}

/**
 * Finished matches from the last `days` days played by teams of one country —
 * the "results row" a site can poll and store (newest first).
 */
function countryResults(country, results, teams, days) {
  const wanted = norm(country);
  const index = teamIndex(teams);
  const memberKeys = new Set(
    (teams ?? []).filter((team) => norm(homeCountry(team)) === wanted).map((team) => teamKey(team.name)),
  );
  const since = days > 0 ? Date.now() - days * 86_400_000 : 0;
  return (results ?? [])
    .filter((row) => (row.startsAt ?? 0) >= since)
    .filter((row) => memberKeys.has(teamKey(row.team1?.name)) || memberKeys.has(teamKey(row.team2?.name)))
    .sort((a, b) => (b.startsAt ?? 0) - (a.startsAt ?? 0))
    .map((row) => enrichMatch(row, index, country));
}

/** Matches of every team that `country` claims, plus the events they belong to. */
function countryView(country, matches, teams, results, days = 3) {
  const wanted = norm(country);
  const index = teamIndex(teams);
  const countryOf = (name) => (name ? norm(homeCountry(index.get(teamKey(name)))) : '');

  const upcoming = (matches ?? [])
    .filter((match) => countryOf(match.team1?.name) === wanted || countryOf(match.team2?.name) === wanted)
    .map((match) => enrichMatch(match, index, country))
    .sort((a, b) => (a.startsAt ?? 0) - (b.startsAt ?? 0));

  const members = (teams ?? []).filter((team) => norm(homeCountry(team)) === wanted);

  const events = new Map();
  for (const match of upcoming) {
    if (!match.event || !match.event.name) continue;
    const key = String(match.event.id ?? match.event.name);
    if (events.has(key)) continue;
    events.set(key, {
      id: match.event.id ?? null,
      name: match.event.name,
      url: match.event.id != null ? `https://www.hltv.org/events/${match.event.id}/x` : null,
      logo: match.event.logo ?? null,
      startsAt: null,
      endsAt: null,
      matches: 0,
    });
    events.get(key).matches += 1;
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
    events: Array.from(events.values()),
    teams: members.map((team) => team.name),
    recentDays: days,
    recent: countryResults(country, results, teams, days),
  };
}

async function handleApi(request, url, env) {
  if (url.pathname === '/api/push') {
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    const key = request.headers.get('x-push-key') ?? '';
    if (!env.PUSH_KEY || key !== env.PUSH_KEY) return json({ error: 'Unauthorized.' }, 401);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return json({ error: 'Invalid JSON body.' }, 400);

    const stored = [];
    for (const kind of ['matches', 'events', 'results', 'teams']) {
      if (Array.isArray(body[kind])) {
        await writeSnapshot(env, kind, body[kind]);
        stored.push(`${kind}:${body[kind].length}`);
      }
    }
    if (!stored.length) return json({ error: 'Nothing to store (send matches/events/results).' }, 400);
    return json({ ok: true, stored, at: Date.now() });
  }

  // Kick the snapshot job on demand, for a scheduler that can reach this site but
  // has no GitHub token of its own. Needs REFRESH_KEY (shared secret) and GH_TOKEN
  // (a fine-grained token with Actions: write) as Worker secrets.
  if (url.pathname === '/api/refresh') {
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    const key = request.headers.get('x-refresh-key') ?? url.searchParams.get('key') ?? '';
    if (!env.REFRESH_KEY || key !== env.REFRESH_KEY) return json({ error: 'Unauthorized.' }, 401);
    if (!env.GH_TOKEN) return json({ error: 'GH_TOKEN is not set on this Worker.' }, 503);

    const res = await fetch(
      'https://api.github.com/repos/wikpzpz/snapshot-sync/actions/workflows/push.yml/dispatches',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + env.GH_TOKEN,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'user-agent': 'snapshot-sync',
        },
        body: JSON.stringify({ ref: 'main' }),
      },
    );
    if (res.status !== 204) {
      return json({ dispatched: false, status: res.status, error: (await res.text()).slice(0, 300) }, 502);
    }
    return json({ dispatched: true, at: new Date().toISOString() }, 202);
  }

  if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);

  if (url.pathname === '/api/meta') {
    const kinds = ['matches', 'events', 'results', 'teams'];
    const out = {};
    for (const kind of kinds) {
      const snapshot = await readSnapshot(env, kind);
      out[kind] = snapshot
        ? { count: snapshot.data.length, updatedAt: new Date(snapshot.updatedAt).toISOString() }
        : null;
    }
    return json({ snapshots: out, hint: 'Run `npm run push` locally to refresh.' });
  }

  if (url.pathname === '/api/matches') {
    const [snapshot, directory] = await Promise.all([readSnapshot(env, 'matches'), readSnapshot(env, 'teams')]);
    if (!snapshot) return json({ error: 'No snapshot yet — run `npm run push` locally.' }, 503);
    const index = teamIndex(directory?.data);
    return json(snapshot.data.map((match) => enrichMatch(match, index)));
  }

  // One match by id, from the matches snapshot or the results pages.
  const matchById = url.pathname.match(/^\/api\/match\/(\d+)$/);
  if (matchById) {
    const id = Number(matchById[1]);
    const [matches, results, directory] = await Promise.all([
      readSnapshot(env, 'matches'),
      readSnapshot(env, 'results'),
      readSnapshot(env, 'teams'),
    ]);
    const index = teamIndex(directory?.data);
    const card = (matches?.data ?? []).find((match) => match.id === id);
    if (card) return json(enrichMatch(card, index));
    const result = (results?.data ?? []).find((row) => row.id === id);
    if (result) return json(enrichMatch(result, index));
    return json({ error: `Match ${id} is not in the snapshot (it may have scrolled past the 241 cards / 100 results).` }, 404);
  }

  if (url.pathname === '/api/events') {
    const snapshot = await readSnapshot(env, 'events');
    if (!snapshot) return json({ error: 'No snapshot yet — run `npm run push` locally.' }, 503);
    return json(snapshot.data);
  }

  if (url.pathname === '/api/results') {
    const [snapshot, directory] = await Promise.all([readSnapshot(env, 'results'), readSnapshot(env, 'teams')]);
    if (!snapshot) return json({ error: 'No snapshot yet — run `npm run push` locally.' }, 503);
    const index = teamIndex(directory?.data);
    const days = Number(url.searchParams.get('days') ?? 0) || 0;
    const team = norm(url.searchParams.get('team'));
    const since = days > 0 ? Date.now() - days * 86_400_000 : 0;
    const rows = snapshot.data.filter(
      (row) =>
        (row.startsAt ?? 0) >= since &&
        (!team || norm(row.team1?.name) === team || norm(row.team2?.name) === team),
    );
    const offset = Number(url.searchParams.get('offset') ?? 0) || 0;
    return json(rows.slice(offset, offset + 100).map((row) => enrichMatch(row, index)));
  }

  if (url.pathname === '/api/search') {
    const query = norm(url.searchParams.get('q'));
    if (query.length < 2) return json({ error: 'Type at least 2 characters.' }, 400);
    const [matches, events, directory] = await Promise.all([
      readSnapshot(env, 'matches'),
      readSnapshot(env, 'events'),
      readSnapshot(env, 'teams'),
    ]);
    // Teams with a fixture come from the match cards; the rest come from the
    // directory, so a team without an upcoming match is still searchable.
    const fromMatches = collectTeams(matches?.data, events?.data).filter((team) => norm(team.name).includes(query));
    const fromDirectory = (directory?.data ?? [])
      .filter((team) => team && team.name && norm(team.name).includes(query))
      .map((team) => ({
        id: team.id ?? 0,
        name: team.name,
        url: team.id ? `https://www.hltv.org/team/${team.id}/x` : null,
        logo: team.logo ?? null,
        country: team.country ?? null,
        flag: team.flag ?? null,
      }));
    const knownNames = new Set(fromDirectory.map((team) => teamKey(team.name)));
    const teams = [...fromDirectory, ...fromMatches.filter((team) => !knownNames.has(teamKey(team.name)))];
    return json({
      query,
      teams: teams.slice(0, 8),
      countries: query.length >= 3 ? searchCountries(directory?.data, query) : [],
      updatedAt: matches ? new Date(matches.updatedAt).toISOString() : null,
    });
  }

  // Finished matches of one country's teams, e.g. /api/country/Sweden/results?days=3
  const countryResultsMatch = url.pathname.match(/^\/api\/country\/(.+)\/results$/);
  if (countryResultsMatch) {
    const country = decodeURIComponent(countryResultsMatch[1]).trim();
    if (!country) return json({ error: 'Name a country, e.g. /api/country/Sweden/results?days=3.' }, 400);
    const [results, directory] = await Promise.all([readSnapshot(env, 'results'), readSnapshot(env, 'teams')]);
    if (!results) return json({ error: 'No results snapshot yet — run `npm run push` locally.' }, 503);
    const days = resultDays(url.searchParams.get('days'));
    const rows = countryResults(country, results.data, directory?.data, days);
    const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0);
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') ?? 100) || 100));
    return json({
      country,
      days,
      total: rows.length,
      results: rows.slice(offset, offset + limit),
      updatedAt: new Date(results.updatedAt).toISOString(),
    });
  }

  // Every upcoming match of the teams from one country, e.g. /api/country/Sweden
  const countryMatch = url.pathname.match(/^\/api\/country\/(.+)$/);
  if (countryMatch) {
    const country = decodeURIComponent(countryMatch[1]).trim();
    if (!country) return json({ error: 'Name a country, e.g. /api/country/Sweden.' }, 400);
    const [matches, directory, results] = await Promise.all([
      readSnapshot(env, 'matches'),
      readSnapshot(env, 'teams'),
      readSnapshot(env, 'results'),
    ]);
    if (!matches) return json({ error: 'No snapshot yet — run `npm run push` locally.' }, 503);
    if (!directory) {
      return json({ error: 'The snapshot has no team countries yet — run `npm run push` locally.' }, 503);
    }
    const days = resultDays(url.searchParams.get('days'));
    return json({
      ...countryView(country, matches.data, directory.data, results?.data, days),
      updatedAt: new Date(matches.updatedAt).toISOString(),
    });
  }

  const teamMatch = url.pathname.match(/^\/api\/team\/(\d+)$/);
  if (teamMatch) {
    const name = url.searchParams.get('name');
    if (!name) return json({ error: 'This hosted API looks teams up by name: /api/team/0?name=FaZe.' }, 400);
    const [matches, events, directory, results] = await Promise.all([
      readSnapshot(env, 'matches'),
      readSnapshot(env, 'events'),
      readSnapshot(env, 'teams'),
      readSnapshot(env, 'results'),
    ]);
    if (!matches) return json({ error: 'No snapshot yet — run `npm run push` locally.' }, 503);
    const view = teamView(name, matches.data, events?.data);
    const index = teamIndex(directory?.data);
    // The team profile itself gets the same country/flag/id as its matches.
    const entry = index.get(teamKey(view.team.name));
    if (entry) {
      view.team.country = homeCountry(entry);
      view.team.region = entry.country ?? null;
      view.team.core = entry.core ?? null;
      view.team.flag = entry.flag ?? null;
      if (entry.id) {
        view.team.id = entry.id;
        view.team.url = `https://www.hltv.org/team/${entry.id}/x`;
      }
      if (entry.logo) view.team.logo = entry.logo;
    }
    // Finished matches from the last three days, newest first.
    const wanted = norm(name);
    const recent = (results?.data ?? [])
      .filter(
        (row) =>
          (row.startsAt ?? 0) >= Date.now() - 3 * 86_400_000 &&
          (norm(row.team1?.name) === wanted || norm(row.team2?.name) === wanted),
      )
      .sort((a, b) => (b.startsAt ?? 0) - (a.startsAt ?? 0))
      .map((row) => enrichMatch(row, index));
    return json({
      ...view,
      upcoming: view.upcoming.map((match) => enrichMatch(match, index)),
      recent,
      updatedAt: new Date(matches.updatedAt).toISOString(),
    });
  }

  return json({ error: 'Unknown endpoint.' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS });
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, url, env);
      } catch (error) {
        return json({ error: String(error && error.message ? error.message : error) }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
