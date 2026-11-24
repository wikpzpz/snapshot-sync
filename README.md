# cs2api

Typed client and small JSON API for the undocumented HTTP surface of
[hltv.org](https://www.hltv.org): live/upcoming matches, finished results, events, event details,
single match details, team search and a team's fixtures + country.

HLTV has no public JSON API — the site is server-rendered HTML. This project is the result of
reverse engineering those documents (see [`docs/ENDPOINTS.md`](docs/ENDPOINTS.md) for the raw
findings, response codes and selectors), plus parsers that turn the markup into typed objects.

## Requirements

- Node.js 22.16+ (runs TypeScript directly via `--experimental-strip-types`, no build step)
- **No browser and no window.** `npm run setup:curl` downloads
  [curl-impersonate](https://github.com/lexiforest/curl-impersonate) into `.tools/`, and the client
  then makes normal HTTP requests carrying Chrome's TLS/HTTP2 fingerprint (profile `chrome131`) —
  which is what hltv.org's Cloudflare rule accepts.
- Google Chrome is only needed if you opt into the `browser` fallback transport.

## Setup

```bash
npm install
npm run setup:curl   # one-time, ~2 MB download into .tools/
```

## CLI

```bash
npm run matches -- --limit 5                 # live + upcoming matches
npm run results -- --limit 5                 # finished matches
npm run results -- --offset 100              # next page (HLTV pages in steps of 100)
npm run events                               # ongoing + upcoming events
node --experimental-strip-types src/cli.ts match 2400564      # one match (maps, scores, teams)
node --experimental-strip-types src/cli.ts event 9303         # one event
node --experimental-strip-types src/cli.ts matches --json --limit 3
```

## Library

```ts
import { HltvClient } from './src/client.ts';

const hltv = new HltvClient();          // headless Chrome transport
try {
  const matches = await hltv.getMatches();                 // MatchCard[]
  const live = matches.filter((m) => m.status === 'live');
  const results = await hltv.getResults({ offset: 0 });     // MatchResult[]
  const { ongoing, upcoming } = await hltv.getEvents();     // EventSummary[]
  const event = await hltv.getEvent(9303);                  // EventDetail
  const match = await hltv.getMatch(2400564);               // MatchDetail
  console.log(live[0]?.team1?.name, results[0]?.score, event.prizePool, match.maps);
} finally {
  await hltv.close();                                     // always close: it owns a browser
}
```

```ts
await hltv.getMatches({ eventIds: [9303] });   // filtered on the parsed cards
await hltv.getResults({ eventId: 9303 });      // /results?offset=0&event=9303 (server-side)
```

`getMatches({ eventIds })` filters in this client on purpose: `/matches?event=` returns all 200+
cards unchanged, because HLTV applies that filter with JavaScript in the browser.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `mode` | `'auto'` | `'auto'` = `curl` when curl-impersonate is present, else `browser`. `'browser'` drives Chrome, `'fetch'` is plain HTTP needing a valid `cookie`. |
| `impersonate` | `'chrome131'` | TLS fingerprint profile for `curl` mode. |
| `cookie` | – | Raw `Cookie:` header for `mode: 'fetch'` (must include a fresh `cf_clearance`). |
| `headless` | `true` | Set `false` (CLI: `--headful`) to watch the browser, useful when Cloudflare challenges. |
| `executablePath` | auto | Explicit Chrome/Chromium binary. |
| `timeoutMs` | `30000` | Per-navigation timeout. |
| `delayMs` | `250` | Delay between navigations (politeness). |

Requests are serialized through a single browser page; reuse one `HltvClient` rather than creating
one per call.

## Hosted API (Freebuff Sites) — snapshot mode

Live at **https://cs2api-461yz8-preview.freebuff.site**. It needs **no API keys and no paid service**.

Why it works this way: a Worker cannot run curl-impersonate, its own `fetch()` to hltv.org returns
`403`, and every free keyless renderer (`r.jina.ai`, `api.microlink.io`) rate-limits Cloudflare's
shared egress IPs with `429`. So the hosted Worker does not scrape at all — your machine does, where
curl-impersonate works, and pushes the parsed JSON:

```bash
npm run push     # scrape locally, upload snapshots to the site's D1
```

```
GET  /api/meta                 freshness + row counts
GET  /api/matches              241 live/upcoming cards
GET  /api/events               96 ongoing/upcoming events
GET  /api/results?offset=      100 finished matches per page
GET  /api/search?q=sweden      teams and countries found in the snapshot
GET  /api/team/0?name=FaZe     that team's upcoming matches + events
GET  /api/country/Sweden       every upcoming match of that country's teams
POST /api/push                 (header: x-push-key) replace snapshots
```

`npm run push` reads the write key from `.secrets/push-key`, which is also stored as the site's
`PUSH_KEY` secret. Without that key `/api/push` answers `401`; every read endpoint is public.

### Keeping it fresh for free (no PC needed)

`.github/workflows/push.yml` runs `npm run push` on a GitHub runner every 20 minutes. GitHub runners
have their own IPs and can install curl-impersonate, which is exactly what a Cloudflare-protected
site needs; public repos get unlimited Actions minutes, and a private repo's 2 000 free minutes
cover a 20-minute cadence.

One-time setup after pushing this project to GitHub:

1. Repo → **Settings → Secrets and variables → Actions → New repository secret**
   Name `PUSH_KEY`, value = the contents of `.secrets/push-key`.
2. **Actions → Push cs2api snapshot → Run workflow** (the first run is the slow one: it builds the
   team-country directory).

Without that workflow the site still works — it just serves the last snapshot you pushed.

### Countries

Team countries are not in `/matches` cards: they live on each match page (`teamsBox`), so
`npm run push` walks the match pages of unknown teams once and caches the result in
`.cache/teams.json` (that file is restored through the Actions cache, so later runs only look up
new teams). Country names come straight from the flag's `alt` text, so Sweden, Europe and `Other`
are all treated as countries.

Trade-offs:

- Data is as fresh as the last push (the UI shows the snapshot timestamp).
- Only teams with a scheduled match on `/matches` or `/results` get a country, so a country shows
  the teams that actually have fixtures. Cards HLTV renders as "TBD" (no teams yet) contribute
  nothing until HLTV fills them in.
- The hosted API resolves teams **by name** (`/api/team/0?name=FaZe`), because the snapshot has no
  team page; `team.url` is `null` there. The local API uses ids and returns the full profile.

```bash
npm run build:worker   # esbuild bundle → deploy/worker.js (7 KB)
```

## Getting past Cloudflare

Measured against hltv.org while building this:

| Client | Result |
| --- | --- |
| node `fetch` / plain `curl` | `403 Just a moment...` |
| headless Chrome | `403`, challenge never clears |
| headful Chrome, one reused context | first page ok, then challenged |
| headful Chrome, fresh context per request | `200` every time |
| curl-impersonate `--impersonate chrome136` | `403` |
| **curl-impersonate `--impersonate chrome131`** | `200` on matches, search, team, events, results |

Cloudflare scores the TLS ClientHello + HTTP/2 fingerprint, so the impersonation profile (not the
headers) decides the outcome. That is why the default transport is a plain HTTP request through
curl-impersonate: no browser process, no window, ~0.5–1.5 s per page.

## What is and isn't exposed

- **Live scores are not in the HTML.** Live cards only carry `data-livescore-match`; the numbers are
  pushed by `https://scorebot-lb.hltv.org` (the URL is in `body[data-livescore-server-url]`). That
  socket is documented in `docs/ENDPOINTS.md` but not implemented here, so `MatchCard.score` is null.
- **`/api/matches`, `/api/events`, `/api/teams`, `/api/streams` exist but answer `401`** — they need
  HLTV's own authenticated session token. Nothing in this client depends on them.
- **`/results` has no day headings** on the flat list. The page contains a 16-card "Featured
  results" preview without timestamps plus `.results-holder.allres` with the 100 paginated rows, each
  carrying `data-zonedgrouping-entry-unix`; only the latter is parsed, and that attribute is
  `MatchResult.startsAt`.
- **There is no team-id filter.** Match cards expose team names and logos but not team ids, so
  filtering by team would need the team's own match page (`/team/<id>/matches`), which is not wrapped here.
- **Series format (`bo1`/`bo3`) is only on the match card**, not on the match detail page, so
  `MatchDetail` has no `format` field.

## Verification

`npx tsc --noEmit` typechecks clean, and each CLI command and API route was run against live
hltv.org. See `docs/ENDPOINTS.md` for the evidence behind each endpoint and the Cloudflare matrix.
