// deploy/api.js
var HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-push-key",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "cache-control": "public, max-age=60"
};
var NO_STORE = { ...HEADERS, "cache-control": "no-store" };
function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    // 202 means "queued, try again": it must never be cached for a minute.
    headers: status >= 400 || status === 202 ? NO_STORE : HEADERS
  });
}
var schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS snapshots (kind TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)"
  ).run();
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS details (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)"
  ).run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS detail_queue (id INTEGER PRIMARY KEY, requested_at INTEGER NOT NULL)").run();
  schemaReady = true;
}
async function readSnapshot(env, kind) {
  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT payload, updated_at FROM snapshots WHERE kind = ?").bind(kind).first();
  if (!row) return null;
  return { data: JSON.parse(row.payload), updatedAt: row.updated_at };
}
async function writeSnapshot(env, kind, data) {
  await ensureSchema(env);
  await env.DB.prepare(
    "INSERT INTO snapshots (kind, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at"
  ).bind(kind, JSON.stringify(data), Date.now()).run();
}
var realTeamName = (team) => team?.name && !/^team[12]$/i.test(team.name) ? team.name : null;
var hasDetailContent = (detail) => Boolean(
  detail && ((detail.veto?.steps?.length ?? 0) > 0 || (detail.lineups?.length ?? 0) > 0 || (detail.stats?.length ?? 0) > 0 || (detail.maps?.length ?? 0) > 0 || realTeamName(detail.team1) || realTeamName(detail.team2))
);
async function readDetail(env, id) {
  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT payload, updated_at FROM details WHERE id = ?").bind(id).first();
  if (!row) return null;
  const data = JSON.parse(row.payload);
  if (!hasDetailContent(data)) return null;
  return { data, updatedAt: row.updated_at };
}
async function writeDetail(env, detail) {
  await ensureSchema(env);
  await env.DB.prepare(
    "INSERT INTO details (id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at"
  ).bind(Number(detail.id), JSON.stringify(detail), Date.now()).run();
}
async function queueDetail(env, id) {
  await ensureSchema(env);
  await env.DB.prepare("INSERT OR REPLACE INTO detail_queue (id, requested_at) VALUES (?, ?)").bind(id, Date.now()).run();
}
async function queuedDetailIds(env, limit) {
  await ensureSchema(env);
  const { results } = await env.DB.prepare("SELECT id FROM detail_queue ORDER BY requested_at LIMIT ?").bind(limit).all();
  return (results ?? []).map((row) => row.id);
}
async function clearQueued(env, ids) {
  if (!ids.length) return;
  await ensureSchema(env);
  for (const id of ids) {
    await env.DB.prepare("DELETE FROM detail_queue WHERE id = ?").bind(id).run();
  }
}
var norm = (value) => String(value ?? "").toLowerCase().trim();
var teamKey = (name) => norm(name).replace(/[^a-z0-9]/g, "");
var homeCountry = (team) => team ? team.core || team.country || null : null;
function teamIndex(teams) {
  const index = /* @__PURE__ */ new Map();
  for (const team of teams ?? []) {
    if (team && team.name) index.set(teamKey(team.name), team);
  }
  return index;
}
function enrichMatch(match, index, country) {
  const entryOf = (team) => team && team.name ? index.get(teamKey(team.name)) ?? null : null;
  const withCountry = (team) => team ? { ...team, country: homeCountry(entryOf(team)), flag: entryOf(team)?.flag ?? null } : null;
  const team1 = withCountry(match.team1);
  const team2 = withCountry(match.team2);
  if (!country) return { ...match, team1, team2 };
  const wanted = norm(country);
  const is1 = norm(team1?.country) === wanted;
  const is2 = norm(team2?.country) === wanted;
  return { ...match, team1, team2, countryTeam: is1 && is2 ? "both" : is1 ? "team1" : is2 ? "team2" : null };
}
function collectTeams(matches, events) {
  const names = /* @__PURE__ */ new Map();
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
function teamView(name, matches, events) {
  const wanted = norm(name);
  const mine = (matches ?? []).filter(
    (match) => norm(match.team1?.name) === wanted || norm(match.team2?.name) === wanted
  );
  const logo = mine.find((match) => norm(match.team1?.name) === wanted)?.team1?.logo ?? mine.find((match) => norm(match.team2?.name) === wanted)?.team2?.logo ?? null;
  const uniqueEvents = /* @__PURE__ */ new Map();
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
        matches: 0
      });
    }
    uniqueEvents.get(key).matches += 1;
  }
  for (const event of events ?? []) {
    const key = event.id != null ? `id:${event.id}` : null;
    if (!key || !uniqueEvents.has(key)) continue;
    uniqueEvents.set(key, { ...uniqueEvents.get(key), startsAt: event.startsAt ?? null, endsAt: event.endsAt ?? null });
  }
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
      flag: null
    },
    upcoming: mine.sort((a, b) => (a.startsAt ?? 0) - (b.startsAt ?? 0)),
    events: Array.from(uniqueEvents.values())
  };
}
function searchCountries(teams, query) {
  const wanted = norm(query);
  if (!wanted || wanted.length < 3) return [];
  const hits = /* @__PURE__ */ new Map();
  for (const team of teams ?? []) {
    const country = String(homeCountry(team) ?? "").trim();
    const key = norm(country);
    if (!country || key === "other" || key === "world" || !key.includes(wanted)) continue;
    const hit = hits.get(key) ?? { name: country, teams: 0, flag: team.flag ?? null };
    hit.teams += 1;
    if (!hit.flag && team.flag) hit.flag = team.flag;
    hits.set(key, hit);
  }
  return [...hits.values()].sort((a, b) => b.teams - a.teams).slice(0, 4);
}
function resultDays(raw) {
  if (raw == null || raw === "") return 3;
  const days = Number(raw);
  if (!Number.isFinite(days)) return 3;
  return Math.max(0, Math.min(30, Math.trunc(days)));
}
function countryResults(country, results, teams, days) {
  const wanted = norm(country);
  const index = teamIndex(teams);
  const memberKeys = new Set(
    (teams ?? []).filter((team) => norm(homeCountry(team)) === wanted).map((team) => teamKey(team.name))
  );
  const since = days > 0 ? Date.now() - days * 864e5 : 0;
  return (results ?? []).filter((row) => (row.startsAt ?? 0) >= since).filter((row) => memberKeys.has(teamKey(row.team1?.name)) || memberKeys.has(teamKey(row.team2?.name))).sort((a, b) => (b.startsAt ?? 0) - (a.startsAt ?? 0)).map((row) => enrichMatch(row, index, country));
}
function countryView(country, matches, teams, results, days = 3) {
  const wanted = norm(country);
  const index = teamIndex(teams);
  const countryOf = (name) => name ? norm(homeCountry(index.get(teamKey(name)))) : "";
  const upcoming = (matches ?? []).filter((match) => countryOf(match.team1?.name) === wanted || countryOf(match.team2?.name) === wanted).map((match) => enrichMatch(match, index, country)).sort((a, b) => (a.startsAt ?? 0) - (b.startsAt ?? 0));
  const members = (teams ?? []).filter((team) => norm(homeCountry(team)) === wanted);
  const events = /* @__PURE__ */ new Map();
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
      matches: 0
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
      flag: members.find((team) => team.flag)?.flag ?? null
    },
    upcoming,
    events: Array.from(events.values()),
    teams: members.map((team) => team.name),
    recentDays: days,
    recent: countryResults(country, results, teams, days)
  };
}
async function handleApi(request, url, env) {
  if (url.pathname === "/api/push") {
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
    const key = request.headers.get("x-push-key") ?? "";
    if (!env.PUSH_KEY || key !== env.PUSH_KEY) return json({ error: "Unauthorized." }, 401);
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "Invalid JSON body." }, 400);
    const stored = [];
    for (const kind of ["matches", "events", "results", "teams"]) {
      if (Array.isArray(body[kind])) {
        await writeSnapshot(env, kind, body[kind]);
        stored.push(`${kind}:${body[kind].length}`);
      }
    }
    if (Array.isArray(body.details) || Array.isArray(body.skipped)) {
      let storedDetails = 0;
      const handled = (body.skipped ?? []).map(Number).filter((id) => Number.isFinite(id));
      for (const detail of body.details ?? []) {
        const id = Number(detail?.id);
        if (!Number.isFinite(id) || !hasDetailContent(detail)) continue;
        await writeDetail(env, detail);
        handled.push(id);
        storedDetails += 1;
      }
      await clearQueued(env, handled);
      if (storedDetails) stored.push(`details:${storedDetails}`);
    }
    if (!stored.length) return json({ error: "Nothing to store (send matches/events/results/details)." }, 400);
    return json({ ok: true, stored, at: Date.now() });
  }
  if (url.pathname === "/api/refresh") {
    if (request.method !== "POST" && request.method !== "GET") {
      return json({ error: "Method not allowed." }, 405);
    }
    const reply = (payload, status) => new Response(JSON.stringify(payload, null, 2), { status, headers: NO_STORE });
    const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearers+/i, "");
    const key = request.headers.get("x-refresh-key") ?? request.headers.get("x-refresh") ?? url.searchParams.get("key") ?? url.searchParams.get("k") ?? bearer ?? "";
    if (!env.REFRESH_KEY || key !== env.REFRESH_KEY) {
      return reply(
        {
          error: "Unauthorized.",
          hint: "Send the key as ?key=<key>, or the x-refresh-key header, or Authorization: Bearer <key>.",
          got: {
            queryKey: url.searchParams.has("key"),
            queryK: url.searchParams.has("k"),
            headerXRefreshKey: request.headers.has("x-refresh-key"),
            headerXRefresh: request.headers.has("x-refresh"),
            bearer: !!request.headers.get("authorization"),
            keyLength: String(key).length
          }
        },
        401
      );
    }
    if (!env.GH_TOKEN) return reply({ error: "GH_TOKEN is not set on this Worker." }, 503);
    const res = await fetch(
      "https://api.github.com/repos/wikpzpz/snapshot-sync/actions/workflows/push.yml/dispatches",
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + env.GH_TOKEN,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "user-agent": "snapshot-sync"
        },
        body: JSON.stringify({ ref: "main" })
      }
    );
    if (res.status !== 204) {
      return reply({ dispatched: false, status: res.status, error: (await res.text()).slice(0, 300) }, 502);
    }
    return reply({ dispatched: true, at: (/* @__PURE__ */ new Date()).toISOString() }, 202);
  }
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);
  if (url.pathname === "/api/meta") {
    const kinds = ["matches", "events", "results", "teams"];
    const out = {};
    for (const kind of kinds) {
      const snapshot = await readSnapshot(env, kind);
      out[kind] = snapshot ? { count: snapshot.data.length, updatedAt: new Date(snapshot.updatedAt).toISOString() } : null;
    }
    const detailsRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM details").first();
    const queuedRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM detail_queue").first();
    return json({
      snapshots: out,
      details: { cached: detailsRow?.n ?? 0, queued: queuedRow?.n ?? 0 },
      hint: "Run `npm run push` locally to refresh."
    });
  }
  if (url.pathname === "/api/matches") {
    const [snapshot, directory] = await Promise.all([readSnapshot(env, "matches"), readSnapshot(env, "teams")]);
    if (!snapshot) return json({ error: "No snapshot yet \u2014 run `npm run push` locally." }, 503);
    const index = teamIndex(directory?.data);
    return json(snapshot.data.map((match) => enrichMatch(match, index)));
  }
  const matchDetailsById = url.pathname.match(/^\/api\/match\/(\d+)\/details$/);
  if (matchDetailsById) {
    const id = Number(matchDetailsById[1]);
    const detail = await readDetail(env, id);
    if (!detail || url.searchParams.get("refresh") === "1") await queueDetail(env, id);
    if (!detail) {
      return json(
        {
          id,
          details: null,
          pending: true,
          retryAfter: 60,
          hint: "Queued: the next sync run (a few minutes) scrapes the match page and stores it."
        },
        202
      );
    }
    return json({
      id,
      details: detail.data,
      updatedAt: new Date(detail.updatedAt).toISOString(),
      pending: url.searchParams.get("refresh") === "1"
    });
  }
  const matchById = url.pathname.match(/^\/api\/match\/(\d+)$/);
  if (matchById) {
    const id = Number(matchById[1]);
    const [matches, results, directory] = await Promise.all([
      readSnapshot(env, "matches"),
      readSnapshot(env, "results"),
      readSnapshot(env, "teams")
    ]);
    const index = teamIndex(directory?.data);
    const detail = await readDetail(env, id);
    if (!detail) await queueDetail(env, id);
    const withDetails = (payload) => ({
      ...payload,
      details: detail?.data ?? null,
      detailsUpdatedAt: detail ? new Date(detail.updatedAt).toISOString() : null,
      detailsPending: !detail
    });
    const card = (matches?.data ?? []).find((match) => match.id === id);
    if (card) return json(withDetails(enrichMatch(card, index)));
    const result = (results?.data ?? []).find((row) => row.id === id);
    if (result) return json(withDetails(enrichMatch(result, index)));
    return json(
      { error: `Match ${id} is not in the snapshot (it may have scrolled past the 241 cards / 100 results).` },
      404
    );
  }
  if (url.pathname === "/api/detail-queue") {
    const key = request.headers.get("x-push-key") ?? "";
    if (!env.PUSH_KEY || key !== env.PUSH_KEY) return json({ error: "Unauthorized." }, 401);
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") ?? 20) || 20));
    if (url.searchParams.get("warm") === "1") {
      const [matches, results] = await Promise.all([readSnapshot(env, "matches"), readSnapshot(env, "results")]);
      const cached = new Set(((await env.DB.prepare("SELECT id FROM details").all()).results ?? []).map((row) => row.id));
      const pending = new Set(await queuedDetailIds(env, 100));
      const candidates = [...matches?.data ?? [], ...results?.data ?? []].filter((row) => row?.id != null && !cached.has(row.id) && !pending.has(row.id)).sort((a, b) => (b.startsAt ?? 0) - (a.startsAt ?? 0)).slice(0, limit);
      for (const row of candidates) await queueDetail(env, row.id);
    }
    return json({ ids: await queuedDetailIds(env, limit), at: Date.now() });
  }
  if (url.pathname === "/api/events") {
    const snapshot = await readSnapshot(env, "events");
    if (!snapshot) return json({ error: "No snapshot yet \u2014 run `npm run push` locally." }, 503);
    return json(snapshot.data);
  }
  if (url.pathname === "/api/results") {
    const [snapshot, directory] = await Promise.all([readSnapshot(env, "results"), readSnapshot(env, "teams")]);
    if (!snapshot) return json({ error: "No snapshot yet \u2014 run `npm run push` locally." }, 503);
    const index = teamIndex(directory?.data);
    const days = Number(url.searchParams.get("days") ?? 0) || 0;
    const team = norm(url.searchParams.get("team"));
    const since = days > 0 ? Date.now() - days * 864e5 : 0;
    const rows = snapshot.data.filter(
      (row) => (row.startsAt ?? 0) >= since && (!team || norm(row.team1?.name) === team || norm(row.team2?.name) === team)
    );
    const offset = Number(url.searchParams.get("offset") ?? 0) || 0;
    return json(rows.slice(offset, offset + 100).map((row) => enrichMatch(row, index)));
  }
  if (url.pathname === "/api/search") {
    const query = norm(url.searchParams.get("q"));
    if (query.length < 2) return json({ error: "Type at least 2 characters." }, 400);
    const [matches, events, directory] = await Promise.all([
      readSnapshot(env, "matches"),
      readSnapshot(env, "events"),
      readSnapshot(env, "teams")
    ]);
    const fromMatches = collectTeams(matches?.data, events?.data).filter((team) => norm(team.name).includes(query));
    const fromDirectory = (directory?.data ?? []).filter((team) => team && team.name && norm(team.name).includes(query)).map((team) => ({
      id: team.id ?? 0,
      name: team.name,
      url: team.id ? `https://www.hltv.org/team/${team.id}/x` : null,
      logo: team.logo ?? null,
      country: team.country ?? null,
      flag: team.flag ?? null
    }));
    const knownNames = new Set(fromDirectory.map((team) => teamKey(team.name)));
    const teams = [...fromDirectory, ...fromMatches.filter((team) => !knownNames.has(teamKey(team.name)))];
    return json({
      query,
      teams: teams.slice(0, 8),
      countries: query.length >= 3 ? searchCountries(directory?.data, query) : [],
      updatedAt: matches ? new Date(matches.updatedAt).toISOString() : null
    });
  }
  const countryResultsMatch = url.pathname.match(/^\/api\/country\/(.+)\/results$/);
  if (countryResultsMatch) {
    const country = decodeURIComponent(countryResultsMatch[1]).trim();
    if (!country) return json({ error: "Name a country, e.g. /api/country/Sweden/results?days=3." }, 400);
    const [results, directory] = await Promise.all([readSnapshot(env, "results"), readSnapshot(env, "teams")]);
    if (!results) return json({ error: "No results snapshot yet \u2014 run `npm run push` locally." }, 503);
    const days = resultDays(url.searchParams.get("days"));
    const rows = countryResults(country, results.data, directory?.data, days);
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 100) || 100));
    return json({
      country,
      days,
      total: rows.length,
      results: rows.slice(offset, offset + limit),
      updatedAt: new Date(results.updatedAt).toISOString()
    });
  }
  const countryMatch = url.pathname.match(/^\/api\/country\/(.+)$/);
  if (countryMatch) {
    const country = decodeURIComponent(countryMatch[1]).trim();
    if (!country) return json({ error: "Name a country, e.g. /api/country/Sweden." }, 400);
    const [matches, directory, results] = await Promise.all([
      readSnapshot(env, "matches"),
      readSnapshot(env, "teams"),
      readSnapshot(env, "results")
    ]);
    if (!matches) return json({ error: "No snapshot yet \u2014 run `npm run push` locally." }, 503);
    if (!directory) {
      return json({ error: "The snapshot has no team countries yet \u2014 run `npm run push` locally." }, 503);
    }
    const days = resultDays(url.searchParams.get("days"));
    return json({
      ...countryView(country, matches.data, directory.data, results?.data, days),
      updatedAt: new Date(matches.updatedAt).toISOString()
    });
  }
  const teamMatch = url.pathname.match(/^\/api\/team\/(\d+)$/);
  if (teamMatch) {
    const name = url.searchParams.get("name");
    if (!name) return json({ error: "This hosted API looks teams up by name: /api/team/0?name=FaZe." }, 400);
    const [matches, events, directory, results] = await Promise.all([
      readSnapshot(env, "matches"),
      readSnapshot(env, "events"),
      readSnapshot(env, "teams"),
      readSnapshot(env, "results")
    ]);
    if (!matches) return json({ error: "No snapshot yet \u2014 run `npm run push` locally." }, 503);
    const view = teamView(name, matches.data, events?.data);
    const index = teamIndex(directory?.data);
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
    const wanted = norm(name);
    const recent = (results?.data ?? []).filter(
      (row) => (row.startsAt ?? 0) >= Date.now() - 3 * 864e5 && (norm(row.team1?.name) === wanted || norm(row.team2?.name) === wanted)
    ).sort((a, b) => (b.startsAt ?? 0) - (a.startsAt ?? 0)).map((row) => enrichMatch(row, index));
    return json({
      ...view,
      upcoming: view.upcoming.map((match) => enrichMatch(match, index)),
      recent,
      updatedAt: new Date(matches.updatedAt).toISOString()
    });
  }
  return json({ error: "Unknown endpoint." }, 404);
}
var api_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, url, env);
      } catch (error) {
        return json({ error: String(error && error.message ? error.message : error) }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  }
};
export {
  api_default as default
};
