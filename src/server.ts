import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HltvClient } from './client.ts';
import { countryView, enrichMatch, loadDirectory, searchCountries, teamKey } from './directory.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', 'public');
const PORT = Number(process.env.PORT) || 5175;
const HOST = '127.0.0.1';
const CACHE_TTL_MS = 60_000;

// Default `auto` transport: curl-impersonate when installed (no browser at all),
// otherwise real Chrome. Override with HLTV_MODE=curl|browser|fetch.
const requestedMode = process.env.HLTV_MODE;
const client = new HltvClient(
  requestedMode === 'curl' || requestedMode === 'browser' || requestedMode === 'fetch'
    ? { mode: requestedMode }
    : {},
);
const cache = new Map<string, { at: number; data: unknown }>();

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data as T;
  const data = await load();
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  return data;
}

// Another site may call this API from its own origin (localhost included).
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    ...CORS_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow, noarchive',
  });
  res.end(body);
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (url.pathname === '/api/search') {
    const query = (url.searchParams.get('q') ?? '').trim();
    if (query.length < 2) {
      sendJson(res, 400, { error: 'Type at least 2 characters.' });
      return;
    }
    const [teams, directory] = await Promise.all([
      cached(`search:${query.toLowerCase()}`, () => client.searchTeams(query)),
      // Countries and fixture-less teams come from the team directory.
      cached('directory', () => loadDirectory()),
    ]);
    const wanted = query.toLowerCase();
    const known = Object.values(directory)
      .filter((team) => team.name.toLowerCase().includes(wanted))
      .map((team) => ({
        id: team.id ?? 0,
        name: team.name,
        url: team.id ? `https://www.hltv.org/team/${team.id}/x` : null,
        logo: team.logo ?? null,
        country: team.country ?? null,
        flag: team.flag ?? null,
      }));
    const knownKeys = new Set(known.map((team) => teamKey(team.name)));
    const merged = [...known, ...teams.filter((team) => !knownKeys.has(teamKey(team.name)))];
    sendJson(res, 200, { query, teams: merged.slice(0, 8), countries: searchCountries(directory, query) });
    return;
  }

  // Every upcoming match of the teams from one country, e.g. /api/country/Sweden
  const countryMatch = url.pathname.match(/^\/api\/country\/(.+)$/);
  if (countryMatch) {
    const country = decodeURIComponent(countryMatch[1]).trim();
    if (!country) {
      sendJson(res, 400, { error: 'Name a country, e.g. /api/country/Sweden.' });
      return;
    }
    const matches = await cached('matches', () => client.getMatches());
    const directory = await cached('directory', () => loadDirectory());
    sendJson(res, 200, countryView(country, matches, directory));
    return;
  }

  const teamMatch = url.pathname.match(/^\/api\/team\/(\d+)$/);
  if (teamMatch) {
    const id = Number(teamMatch[1]);
    const data = await cached(`team:${id}`, () => client.getTeamUpcoming(id));
    const directory = await cached('directory', () => loadDirectory());
    sendJson(res, 200, { ...data, upcoming: data.upcoming.map((match) => enrichMatch(match, directory)) });
    return;
  }

  sendJson(res, 404, { error: 'Unknown endpoint.' });
}

async function handleStatic(res: ServerResponse, pathname: string): Promise<void> {
  const file = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  if (!/^[a-zA-Z0-9._-]+$/.test(file)) {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    const body = await readFile(join(PUBLIC_DIR, file));
    const type = file.endsWith('.css')
      ? 'text/css; charset=utf-8'
      : file.endsWith('.js')
        ? 'text/javascript; charset=utf-8'
        : file.endsWith('.txt') || file === 'robots.txt'
          ? 'text/plain; charset=utf-8'
          : 'text/html; charset=utf-8';
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store',
      // Keep the tool out of search indexes and caches.
      'x-robots-tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${url.pathname}] ${message}`);
    if (!res.headersSent) sendJson(res, 500, { error: message });
  };

  if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
    res.writeHead(204, CORS_HEADERS).end();
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch(fail);
    return;
  }
  handleStatic(res, url.pathname).catch(fail);
});

server.listen(PORT, HOST, () => {
  console.log(`cs2api running at http://${HOST}:${PORT} (transport: ${client.http.transport})`);
});

const shutdown = () => {
  server.close();
  void client.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
