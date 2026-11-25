// `cheerio/slim` has no Node-only dependencies, so the same parsers run in Node
// and in the Cloudflare Worker bundle (see deploy/api.js).
import { load } from 'cheerio/slim';
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import type {
  EventDetail,
  EventRef,
  EventSummary,
  LineupPlayer,
  MapScore,
  MapStats,
  MatchCard,
  MatchDetail,
  MatchResult,
  MatchVeto,
  TeamLineup,
  TeamRef,
  TeamStats,
  VetoStep,
} from './types.ts';

const MATCH_HREF = /^\/matches\/(\d+)\//;
const EVENT_HREF = /^\/events\/(\d+)\//;
const TEAM_HREF = /^\/team\/(\d+)\//;

type Doc = CheerioAPI;

export const clean = (value: string | undefined | null): string | null => {
  if (value == null) return null;
  const text = value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length ? text : null;
};

export const toInt = (value: string | undefined | null): number | null => {
  if (value == null) return null;
  const match = value.replace(/\u00a0/g, ' ').match(/-?\d+/);
  return match ? Number(match[0]) : null;
};

const toNumber = (value: string | undefined | null): number | null => {
  const text = clean(value);
  return text == null ? null : toInt(text);
};

/** Absolute image URL for the source's protocol-relative/relative `src`s. */
/**
 * Strip any origin from an href.
 *
 * Pages rendered by microlink come back with absolute URLs (`https://www.the source site/team/6667/faze`),
 * while the raw HTML uses relative ones. Normalising keeps every parser and
 * `a[href^="/…"]` selector working for both.
 */
export const pathOf = (href: string | undefined | null): string =>
  (href ?? '').replace(/^https?:\/\/[^/]+/i, '');

/**
 * Team names scraped from anchors sometimes carry trailing junk such as
 * `Alliance#37#48` (an internal seed). Strip it so lookups still match.
 */
export const cleanName = (value: string | null | undefined): string | null => {
  const text = clean(value);
  if (!text) return null;
  return text.replace(/#\d+(#\d+)*$/, '').trim() || null;
};

export const imgUrl = (src: string | undefined): string | null => {
  if (!src) return null;
  if (src.startsWith('//')) return 'https:' + src;
  if (src.startsWith('/')) return 'https://www.hltv.org' + src;
  return src;
};

/** First `data-unix` (milliseconds) under a node, in document order. */
const unixAt = ($: Doc, node: Cheerio<AnyNode>, index = 0): number | null => {
  const el = node.find('[data-unix]').get(index);
  return el ? toInt($(el).attr('data-unix')) : null;
};

const nodeText = ($: Doc, node: Cheerio<AnyNode>, removeSelectors: string[]): string | null => {
  const clone = node.clone();
  for (const selector of removeSelectors) clone.find(selector).remove();
  return clean(clone.text());
};

function eventRef($: Doc, href: string | undefined, name: string | null, logo: string | null): EventRef | null {
  const id = href ? toInt(href.match(EVENT_HREF)?.[1] ?? null) : null;
  if (!id && !name) return null;
  return { id, name: name ?? '', logo };
}

function teamsFromCard($: Doc, card: Cheerio<AnyNode>): Array<TeamRef | null> {
  const teams: TeamRef[] = [];
  card.find('.match-team').each((_, el) => {
    const node = $(el);
    const name = clean(node.find('.match-teamname').first().text()) ?? clean(node.find('img').first().attr('title'));
    if (!name) return;
    const img = node.find('img').first();
    teams.push({ id: null, name, logo: imgUrl(img.attr('src')) });
  });
  return [teams[0] ?? null, teams[1] ?? null];
}

/**
 * Live cards expose the rounds of the map being played right now in
 * `.current-map-score[data-livescore-current-map-score]`. The maps-won series
 * (`.map-score`, printed as "(1)") is deliberately ignored.
 */
function liveScore($: Doc, card: Cheerio<AnyNode>): { team1: number; team2: number } | null {
  const cells = card.find('.match-team-livescore .match-team-score');
  if (cells.length < 2) return null;

  const roundsOf = (index: number) => {
    const node = cells.eq(index).find('.current-map-score').first();
    return toNumber(node.attr('data-livescore-current-map-score')) ?? toNumber(node.text());
  };

  const left = roundsOf(0);
  const right = roundsOf(1);
  return left == null || right == null ? null : { team1: left, team2: right };
}

/** Cards from the matches page. */
export function parseMatchCards(html: string): MatchCard[] {
  const $ = load(html);
  const cards: MatchCard[] = [];
  const seen = new Set<number>();

  // Pinned and live cards only expose `data-event-id` on their wrapper, never
  // the event name, so map every /events/{id}/ link on the page once.
  const eventInfo = new Map<number, { name: string | null; logo: string | null; strong: boolean }>();
  $('a[href*="/events/"]').each((_, el) => {
    const node = $(el);
    const id = toInt(pathOf(node.attr('href')).match(EVENT_HREF)?.[1] ?? null);
    if (!id) return;
    const img = node.find('img').first();
    // The real headline lives in `.event-headline-text`; links in the live strip
    // only render "Live<event>" as bare text, so they must not win.
    const headline = nodeText($, node.find('.event-headline-text').first(), ['.event-type-tag']);
    const strong = !!headline;
    const existing = eventInfo.get(id);
    if (existing && existing.strong && !strong) return;
    eventInfo.set(id, {
      name: headline ?? clean(img.attr('alt')) ?? existing?.name ?? null,
      logo: imgUrl(img.attr('src')) ?? existing?.logo ?? null,
      strong,
    });
  });

  // A live card nests `.match` inside `.match`, so only take outermost cards.
  $('.match').each((_, el) => {
    const card = $(el);
    if (card.parents('.match').length > 0) return;
    const href = pathOf(card.find('a[href*="/matches/"]').first().attr('href'));
    const id = toInt(href.match(MATCH_HREF)?.[1] ?? null);
    if (!id || seen.has(id)) return;
    seen.add(id);

    const wrapper = card.closest('[data-match-wrapper]');
    const eventNode = card.find('.match-event').first();
    const eventId = toInt(wrapper.attr('data-event-id')) ?? toInt(eventNode.attr('data-event-id'));
    const known = eventId != null ? eventInfo.get(eventId) : undefined;
    const eventName =
      clean(eventNode.attr('data-event-headline')) ??
      nodeText($, eventNode, ['.match-stage', '.match-event-logo-container']) ??
      known?.name ??
      null;
    const eventLogoNode = eventNode.find('img').first();
    const event = eventRef(
      $,
      eventId != null ? `/events/${eventId}/x` : undefined,
      eventName,
      imgUrl(eventLogoNode.attr('src')) ?? known?.logo ?? null,
    );

    const metas = card
      .find('.match-meta')
      .map((__, m) => clean($(m).text()))
      .get()
      .filter((text): text is string => !!text);
    const live =
      metas.some((text) => /^live$/i.test(text)) ||
      card.find('[class*="match-meta-live"]').length > 0 ||
      wrapper.attr('live') === 'true';
    const format = metas.find((text) => /^bo\d$/i.test(text)) ?? null;
    const [team1, team2] = teamsFromCard($, card);
    // The wrapper carries the real team ids: team1="7175" team2="12376".
    if (team1 && team1.id == null) team1.id = toInt(wrapper.attr('team1'));
    if (team2 && team2.id == null) team2.id = toInt(wrapper.attr('team2'));
    const starsAttr = toInt(wrapper.attr('data-stars')) ?? 0;
    const stars = card.find('.match-rating i.fa-star:not(.faded)').length || starsAttr;

    const liveMapScore = live ? liveScore($, card) : null;

    cards.push({
      id,
      url: `https://www.hltv.org${href}`,
      status: live ? 'live' : 'upcoming',
      startsAt: unixAt($, card),
      format: format ? format.toLowerCase() : null,
      stage: nodeText($, card.find('.match-stage').first(), []),
      stars: stars > 0 ? stars : null,
      event,
      team1,
      team2,
      mapScore: liveMapScore,
    });
  });

  return cards;
}

/** Entries from https://www.the source site/results?offset=N */
export function parseResults(html: string): MatchResult[] {
  const $ = load(html);
  const results: MatchResult[] = [];

  // `.results-holder.results-all` is a 16-card "Featured results" preview without
  // timestamps and duplicates rows of `.results-holder.allres`, the paginated list.
  const groups = $('.results-holder.allres .results-sublist').length
    ? $('.results-holder.allres .results-sublist')
    : $('.results-sublist');

  groups.each((_, groupEl) => {
    const group = $(groupEl);
    const dateLabel =
      clean(group.find('.standard-headline').first().text()) ??
      clean(group.find('.results-subheading, .results-date').first().text()) ??
      clean(group.prev('.standard-headline').text());

    group.find('.result-con').each((__, el) => {
      const item = $(el);
      const href = pathOf(item.find('a[href*="/matches/"]').first().attr('href'));
      const id = toInt(href.match(MATCH_HREF)?.[1] ?? null);
      if (!id) return;

      const cells = item.find('td.team-cell');
      const side = (index: number, which: 'team1' | 'team2'): TeamRef & { won: boolean } => {
        const cell = $(cells.get(index));
        const line = cell.find(`.line-align.${which}`).first().length
          ? cell.find(`.line-align.${which}`).first()
          : cell;
        const name = clean(line.find('.team').first().text()) ?? clean(line.find('img').first().attr('title')) ?? '';
        const logo = imgUrl(line.find('img').first().attr('src'));
        const won = line.find('.team-won').length > 0 || /\bwon\b/.test(line.find('.team').first().attr('class') ?? '');
        return { id: null, name, logo, won };
      };

      const eventCell = item.find('td.event').first();
      const event = eventRef(
        $,
        undefined,
        clean(eventCell.find('.event-name').first().text()) ?? clean(eventCell.text()),
        imgUrl(eventCell.find('img').first().attr('src')),
      );

      // Newer markup stamps every row with `data-zonedgrouping-entry-unix`.
      const startsAt = toInt(item.attr('data-zonedgrouping-entry-unix')) ?? unixAt($, item);

      results.push({
        id,
        url: `https://www.hltv.org${href}`,
        dateLabel,
        startsAt,
        score: {
          team1: toNumber(item.find('.result-score .score-won').first().text()),
          team2: toNumber(item.find('.result-score .score-lost').first().text()),
        },
        team1: side(0, 'team1'),
        team2: side(1, 'team2'),
        event,
        map: clean(item.find('.map-text').first().text()),
        starred: item.find('.stars i.fa-star:not(.faded)').length > 0,
      });
    });
  });

  return results;
}

/** Ongoing + upcoming events from https://www.the source site/events */
export function parseEvents(html: string): { ongoing: EventSummary[]; upcoming: EventSummary[] } {
  const $ = load(html);
  const ongoing: EventSummary[] = [];
  const upcoming: EventSummary[] = [];

  const build = (node: Cheerio<AnyNode>, href: string, ongoingFlag: boolean, name: string | null): EventSummary | null => {
    const id = toInt(href.match(EVENT_HREF)?.[1] ?? null);
    if (!id) return null;
    const flag = node.find('img.flag').first();
    return {
      id,
      url: `https://www.hltv.org${href}`,
      name: name ?? '',
      logo: imgUrl(node.find('img').first().attr('src')),
      location: clean(node.find('.big-event-location, .event-location').first().text()),
      country: clean(flag.attr('title')) ?? clean(flag.attr('alt')),
      teams: Array.from(
        new Set(
          node
            .find('.top-team-logos img')
            .map((__, img) => clean($(img).attr('title')) ?? '')
            .get()
            .filter((title): title is string => !!title),
        ),
      ),
      ongoing: ongoingFlag,
    };
  };

  // The page ships desktop/mobile copies of each ongoing card, so dedupe by id.
  $('.ongoing-event').each((_, el) => {
    const node = $(el);
    const href = pathOf(node.attr('href'));
    if (!href) return;
    const name =
      clean(node.find('.event-name-small .text-ellipsis').first().text()) ??
      nodeText($, node.find('.event-name-small').first(), ['.lan-marker']) ??
      clean(node.find('.text-ellipsis').first().text());
    const summary = build(node, href, true, name);
    if (summary && !ongoing.some((event) => event.id === summary.id)) ongoing.push(summary);
  });

  $('.events-month, .events-holder').each((_, monthEl) => {
    const month = $(monthEl);
    month.find('a[href*="/events/"]').each((__, el) => {
      const node = $(el);
      const href = pathOf(node.attr('href'));
      const isBig = node.hasClass('big-event');
      const name = isBig
        ? clean(node.find('.big-event-name').first().text())
        : nodeText($, node.find('.event-name, .text-ellipsis').first(), ['.lan-marker']);
      const summary = build(node, href, false, name);
      if (summary && !upcoming.some((e) => e.id === summary.id)) upcoming.push(summary);
    });
  });

  return { ongoing, upcoming };
}

/** Team names/scores in the match-page header, from `.team1-gradient`/`.team2-gradient`. */
function headerTeam($: Doc, which: 1 | 2, hasTeamNames: boolean): (TeamRef & { score: number | null; won: boolean }) | null {
  const node = $(`.team${which}-gradient`).first();
  if (!node.length) return null;
  const scoreNode = node.find('.won, .lost, .totalrounds').first();
  const name =
    clean(node.find('.teamName, .team-name').first().text()) ??
    nodeText($, node, ['.won', '.lost', '.totalrounds', '.teamRanking', '.ranking']);
  const won = node.find('.won').length > 0;
  const logo = imgUrl(node.find('img').first().attr('src'));
  if (!name && !hasTeamNames) return null;
  return { id: null, name: name ?? `team${which}`, logo, score: toNumber(scoreNode.text()), won };
}

/** https://www.the source site/matches/{id}/{slug} */
/** Player id from "/player/23482/tuxa". */
const playerIdOf = (href: string | undefined | null): number | null => {
  const parts = pathOf(href).split('/');
  return parts[1] === 'player' ? toInt(parts[2]) : null;
};

/** Player slug from "/player/23482/tuxa". */
const playerSlugOf = (href: string | undefined | null): string | null => {
  const parts = pathOf(href).split('/');
  return parts[1] === 'player' ? (clean(parts[3]) ?? null) : null;
};

/** "53-53" -> kills/deaths. */
function kdOf(text: string | null): { kills: number | null; deaths: number | null } {
  const match = (text ?? '').match(/(\d+)\s*-\s*(\d+)/);
  return match ? { kills: Number(match[1]), deaths: Number(match[2]) } : { kills: null, deaths: null };
}

/** First number in a cell that may carry a unit ("66.2%", "+3.47%"). */
function numberOf(text: string | null): number | null {
  const match = (text ?? '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

/**
 * The veto box prints one line per action ("3. SAW Youngsters picked Anubis",
 * "7. Dust2 was left over"); the box above it carries the format.
 */
function parseVeto($: Doc): MatchVeto | null {
  const box = $('.veto-box.real-veto-only').first();
  // The info box ("Best of 3 (Online)") is a plain `.veto-box`; a fixture without an
  // announced veto also carries a `.simulated-veto` box with map win chances, which
  // is printed before the info box in the page and must not be mistaken for the veto.
  const text = clean($('.veto-box:not(.real-veto-only):not(.simulated-veto) .padding').first().text());
  const steps: VetoStep[] = [];

  if (box.length) {
    box.find('.padding div').each((_, el) => {
      const line = clean($(el).text());
      if (!line) return;
      const action = line.match(/^(\d+)\.\s+(.+?)\s+(picked|removed)\s+(.+)$/i);
      const leftOver = line.match(/^(\d+)\.\s+(.+?)\s+was left over$/i);
      if (action) {
        steps.push({
          order: Number(action[1]),
          team: action[2],
          action: action[3].toLowerCase() === 'picked' ? 'picked' : 'removed',
          map: action[4],
        });
      } else if (leftOver) {
        steps.push({ order: Number(leftOver[1]), team: null, action: 'left over', map: leftOver[2] });
      }
    });
  }

  if (!text && steps.length === 0) return null;
  // A fixture whose veto has not happened yet prints a "Veto simulation" box with
  // map win chances; those lines are guesses, not this match's veto.
  if (steps.length === 0 && /veto simulation/i.test(text ?? '')) return null;
  return { text, steps };
}

/** The two lineup boxes: player photos, nicks, roles, team ranking. */
function parseLineups($: Doc): TeamLineup[] {
  const lineups: TeamLineup[] = [];

  $('.lineups .lineup').each((_, el) => {
    const node = $(el);
    const headline = node.find('.box-headline').first();
    const anchor = headline.find('a[href*="/team/"]').first();
    const name = clean(anchor.text()) ?? clean(headline.find('img').first().attr('title'));
    if (!name) return;

    const players: LineupPlayer[] = [];
    // A finished match links each player; an upcoming one lists the same five
    // without a player link, so the id comes from the compare cell instead.
    node.find('td.player-image').each((__, cell) => {
      const box = $(cell);
      const link = box.find('a[href*="/player/"]').first();
      const compare = box.find('[data-player-id]').first();
      const img = box.find('img').first();
      // The photo title is "Daniel 'tuxa' Esteves".
      const alt = clean(img.attr('title')) ?? clean(img.attr('alt')) ?? '';
      const quoted = alt.match(/'([^']+)'/);
      const nick = quoted?.[1] ?? clean(link.text()) ?? playerSlugOf(link.attr('href'));
      if (!nick) return;
      players.push({
        id: playerIdOf(link.attr('href')) ?? toInt(compare.attr('data-player-id') ?? null),
        nick,
        name: quoted ? clean(alt.replace(/'[^']+'/, '')) : null,
        photo: imgUrl(img.attr('src')),
        country: null,
        role: clean(box.find('.role-pill').first().attr('title')),
      });
    });

    lineups.push({
      team: {
        id: toInt(pathOf(anchor.attr('href')).match(TEAM_HREF)?.[1] ?? null),
        name,
        logo: imgUrl(headline.find('img.day-only').first().attr('src') ?? headline.find('img').first().attr('src')),
      },
      ranking: clean(headline.find('.hltv-ranking').first().text())?.replace(/^HLTV:\s*/i, '') ?? null,
      players,
    });
  });

  return lineups;
}

/**
 * The "Match stats" table: a header row names each team, the rows under it are
 * its players (K-D, round swing, ADR, KAST, rating). The eco-adjusted and
 * side-split copies are hidden and skipped through their class names.
 */
function parseStatsTables($: Doc, scope: Cheerio<AnyNode>): TeamStats[] {
  // One table per team per map tab, and the first tab is "All maps", so the first
  // table seen for a team is the one to keep and later duplicates are skipped.
  const tables = scope.find('table.totalstats');
  if (!tables.length) return [];

  const teams: TeamStats[] = [];
  let current: TeamStats | null = null;

  tables.find('tr').each((_, el) => {
    const row = $(el);
    const playersCell = row.find('td.players').first();

    if (row.hasClass('header-row')) {
      const anchor = playersCell.find('a[href*="/team/"]').first();
      const name = clean(anchor.text()) ?? clean(playersCell.find('img').first().attr('title'));
      if (!name || teams.some((team) => team.team.name === name)) {
        current = null;
        return;
      }
      current = {
        team: {
          id: toInt(pathOf(anchor.attr('href')).match(TEAM_HREF)?.[1] ?? null),
          name,
          logo: imgUrl(
            playersCell.find('img.day-only').first().attr('src') ?? playersCell.find('img').first().attr('src'),
          ),
        },
        players: [],
      };
      teams.push(current);
      return;
    }

    if (!current) return;
    const anchor = playersCell.find('a[href*="/player/"]').first();
    if (!anchor.length) return;

    const { kills, deaths } = kdOf(clean(row.find('td.kd.traditional-data').first().text()));
    const flag = playersCell.find('img.flag').first();

    current.players.push({
      playerId: playerIdOf(anchor.attr('href')),
      nick:
        clean(playersCell.find('.player-nick').first().text()) ??
        clean(anchor.text()) ??
        playerSlugOf(anchor.attr('href')) ??
        'unknown',
      country: clean(flag.attr('alt')) ?? clean(flag.attr('title')),
      kills,
      deaths,
      kdDiff: kills != null && deaths != null ? kills - deaths : null,
      swing: clean(row.find('td.roundSwing').first().text()),
      adr: numberOf(clean(row.find('td.adr.traditional-data').first().text())),
      kast: numberOf(clean(row.find('td.kast.traditional-data').first().text())),
      rating: numberOf(clean(row.find('td.rating').first().text())),
      // Only the per-map stats pages print these, so they are filled in later.
      assists: null,
      flashAssists: null,
      headshots: null,
      headshotPct: null,
    });
  });

  return teams;
}

/** The "All maps" tab: every map of the series added together. */
function parsePlayerStats($: Doc): TeamStats[] {
  const all = $('#all-content').first();
  return parseStatsTables($, all.length ? all : $('#match-stats'));
}

/**
 * The same tables per map. Each tab is a `.stats-content` block whose id is the
 * source map-stats page id ("245025-content"), and the tabs follow the map order
 * of the mapholder, so `maps` lines up with them one to one.
 */
function parseMapStats($: Doc, maps: MapScore[]): MapStats[] {
  const perMap: MapStats[] = [];
  let index = 0;

  $('#match-stats .stats-content').each((_, el) => {
    const block = $(el);
    const key = (block.attr('id') ?? '').replace(/-content$/, '');
    if (!/^\d+$/.test(key)) return; // "all-content"
    const map = maps[index];
    index += 1;
    const teams = parseStatsTables($, block);
    if (!teams.length) return;
    perMap.push({ name: map?.name ?? `map ${index}`, mapStatsId: Number(key), teams });
  });

  return perMap;
}

/** One row of the source's per-map stats page. */
export interface DetailedPlayerRow {
  playerId: number | null;
  nick: string;
  kills: number | null;
  headshots: number | null;
  assists: number | null;
  flashAssists: number | null;
  deaths: number | null;
}

const nameKey = (value: string | null | undefined): string =>
  (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Kills and deaths print as "14 (8)": the value plus a bracketed detail. */
function pairOf(text: string | null): { value: number | null; detail: number | null } {
  const detail = text?.match(/\((\d+)\)/)?.[1];
  return { value: numberOf(text), detail: detail == null ? null : Number(detail) };
}

/**
 * The source's per-map stats page (/stats/matches/mapstatsid/{id}): the only place
 * that prints assists and headshot kills. It is bot-checked harder than match
 * pages, so callers treat a failure as "no assists for this map".
 */
export function parseStatsPage(html: string): { team: string | null; players: DetailedPlayerRow[] }[] {
  const $ = load(html);
  const teams: { team: string | null; players: DetailedPlayerRow[] }[] = [];

  $('table.stats-table').each((_, el) => {
    const table = $(el);
    const team = clean(table.find('th.st-teamname').first().text());
    const players: DetailedPlayerRow[] = [];

    table.find('tbody tr').each((__, row) => {
      const cells = $(row);
      const anchor = cells.find('td.st-player a[href*="/stats/players/"]').first();
      if (!anchor.length) return;
      const kills = pairOf(clean(cells.find('td.st-kills.traditional-data').first().text()));
      const assists = pairOf(clean(cells.find('td.st-assists').first().text()));
      const deaths = pairOf(clean(cells.find('td.st-deaths.traditional-data').first().text()));
      players.push({
        playerId: toInt(pathOf(anchor.attr('href')).match(/^\/stats\/players\/(\d+)\//)?.[1] ?? null),
        nick: clean(anchor.text()) ?? 'unknown',
        kills: kills.value,
        headshots: kills.detail,
        assists: assists.value,
        flashAssists: assists.detail,
        deaths: deaths.value,
      });
    });

    if (players.length) teams.push({ team, players });
  });

  return teams;
}

const headshotShare = (headshots: number | null, kills: number | null): number | null =>
  headshots != null && kills ? Math.round((headshots / kills) * 1000) / 10 : null;

/** Copy assists, flash assists and headshot kills onto one map's player rows. */
export function applyDetailedStats(
  map: MapStats,
  teams: { team: string | null; players: DetailedPlayerRow[] }[],
): number {
  const byId = new Map<number, DetailedPlayerRow>();
  for (const team of teams) for (const row of team.players) if (row.playerId != null) byId.set(row.playerId, row);

  let updated = 0;
  for (const team of map.teams) {
    const byName = teams.find((entry) => nameKey(entry.team) === nameKey(team.team.name));
    for (const player of team.players) {
      const row =
        (player.playerId != null ? byId.get(player.playerId) : undefined) ??
        byName?.players.find((entry) => entry.nick === player.nick);
      if (!row) continue;
      player.kills = player.kills ?? row.kills;
      player.assists = row.assists;
      player.flashAssists = row.flashAssists;
      player.headshots = row.headshots;
      player.headshotPct = headshotShare(row.headshots, player.kills ?? row.kills);
      updated += 1;
    }
  }
  return updated;
}

/** Assists and headshot kills summed over the maps, for the "All maps" table. */
export function applySeriesTotals(detail: MatchDetail): number {
  let updated = 0;

  for (const team of detail.stats) {
    for (const player of team.players) {
      if (player.assists != null) continue;
      let assists = 0;
      let flashAssists = 0;
      let headshots = 0;
      let kills = 0;
      for (const map of detail.mapStats) {
        const row = map.teams
          .flatMap((entry) => entry.players)
          .find(
            (entry) =>
              (entry.playerId != null && entry.playerId === player.playerId) || entry.nick === player.nick,
          );
        if (!row || row.assists == null) continue;
        assists += row.assists;
        flashAssists += row.flashAssists ?? 0;
        headshots += row.headshots ?? 0;
        kills += row.kills ?? 0;
      }
      if (!assists && !headshots) continue;
      player.assists = assists;
      player.flashAssists = flashAssists;
      player.headshots = headshots;
      player.headshotPct = headshotShare(headshots, kills || player.kills);
      updated += 1;
    }
  }

  return updated;
}

/** The header prints "team2" while a fixture is TBD, which is not a real name. */
const namedTeam = <T extends { name: string }>(team: T | null): T | null =>
  team && /^team[12]$/i.test(team.name) ? null : team;

export function parseMatchDetail(html: string, id: number, url: string): MatchDetail {
  const $ = load(html);

  const teamHrefs: number[] = [];
  $('a[href*="/team/"]').each((_, el) => {
    const teamId = toInt(pathOf($(el).attr('href')).match(TEAM_HREF)?.[1] ?? null);
    if (teamId && !teamHrefs.includes(teamId)) teamHrefs.push(teamId);
  });

  const team1 = namedTeam(headerTeam($, 1, true));
  const team2 = namedTeam(headerTeam($, 2, true));
  if (team1 && teamHrefs[0]) team1.id = teamHrefs[0];
  if (team2 && teamHrefs[1]) team2.id = teamHrefs[1];

  // The sidebar link carrying a `title` holds the full event name; `.dropdown-link`
  // only has the shortened one ("PGL Major Stage 1").
  const eventAnchors = $('a[href*="/events/"]').filter((_, el) => EVENT_HREF.test(pathOf($(el).attr('href'))));
  const titledAnchor = eventAnchors.filter((_, el) => !!$(el).attr('title')).first();
  const eventAnchor = titledAnchor.length ? titledAnchor : eventAnchors.first();
  const eventHref = pathOf(eventAnchor.attr('href'));
  const eventName = clean(eventAnchor.attr('title')) ?? clean(eventAnchor.text());
  const eventLogo = $('img')
    .filter((_, el) => /eventlogo/.test($(el).attr('src') ?? ''))
    .first();

  const maps: MapScore[] = [];
  $('.mapholder').each((_, el) => {
    const map = $(el);
    // An unstarted match shows a simulated veto with win chances per map
    // ("Ancient - 75%"); those are not the maps of this match.
    if (map.hasClass('simulated-map')) return;
    const name = clean(map.find('.mapname').first().text());
    if (!name) return;
    const left = map.find('.results-left, .results-left.won, .results-left.lost').first();
    const right = map.find('.results-right, .results-right.won, .results-right.lost').first();
    const winner: 1 | 2 | null = map.find('.results-left.won').length
      ? 1
      : map.find('.results-right.won').length
        ? 2
        : null;
    maps.push({
      name,
      team1: toNumber(left.find('.results-team-score').first().text()),
      team2: toNumber(right.find('.results-team-score').first().text()),
      winner,
    });
  });

  const veto = parseVeto($);
  const lineups = parseLineups($);
  const stats = parsePlayerStats($);
  const mapStats = parseMapStats($, maps);

  // The lineup box has no flag; the stats row for the same player does.
  const countryOf = new Map<number, string | null>();
  for (const team of stats) {
    for (const player of team.players) {
      if (player.playerId != null) countryOf.set(player.playerId, player.country);
    }
  }
  for (const lineup of lineups) {
    for (const player of lineup.players) {
      if (player.id != null && countryOf.has(player.id)) player.country = countryOf.get(player.id) ?? null;
    }
  }

  const formatMatch = (veto?.text ?? '').match(/best of\s*(\d)/i);
  const format = formatMatch ? `bo${formatMatch[1]}` : null;

  const title = clean($('title').first().text())?.replace(/\s*\|\s*HLTV\.org\s*$/i, '') ?? null;
  const startsAt =
    toInt($('.date[data-unix]').first().attr('data-unix')) ??
    unixAt($, $('.match-page').length ? $('.match-page') : $('body'));

  // Upcoming fixtures print the same lineup box while the match has no stats and
  // no map scores: those five are the expected lineup, not one that played.
  const expected =
    lineups.length > 0 &&
    stats.length === 0 &&
    maps.every((map) => map.team1 == null && map.team2 == null);

  return {
    id,
    url,
    title,
    event: eventRef($, eventHref, eventName, imgUrl(eventLogo.attr('src'))),
    startsAt,
    team1,
    team2,
    maps,
    format,
    veto,
    lineups,
    stats,
    mapStats,
    expected,
  };
}

/** https://www.the source site/events/{id}/{slug} */
export function parseEventDetail(html: string, id: number, url: string): EventDetail {
  const $ = load(html);
  const header = $('.event-header-component, .event-page').first();
  const scope = header.length ? header : $('body');

  const unixes: number[] = [];
  scope.find('[data-unix]').each((_, el) => {
    const value = toInt($(el).attr('data-unix'));
    if (value) unixes.push(value);
  });

  const name =
    clean($('h1').first().text()) ??
    clean(scope.find('.event-name, .big-event-name').first().text()) ??
    clean($('title').first().text())?.replace(/\s*(overview|matches|prize distribution)?\s*\|\s*HLTV\.org\s*$/i, '') ??
    null;

  const flag = scope.find('img.flag').first();
  // Event header is `table.info`; the `th` labels share these class names, so target `td` only.
  const prizeNode = scope.find('td.prizepool').first();
  const prizePool = clean(prizeNode.attr('title')) ?? clean(prizeNode.text());
  const teamsAttending = toNumber(scope.find('td.teamsNumber').first().text());
  const logoImg = $('img')
    .filter((_, el) => /eventlogo|eventbanner/.test($(el).attr('src') ?? ''))
    .first();
  const location =
    clean(scope.find('td.location .text-ellipsis, .event-location, .big-event-location').first().text()) ??
    clean(flag.attr('title'));

  return {
    id,
    url,
    name: name ?? `event ${id}`,
    logo: imgUrl(logoImg.attr('src')),
    startsAt: unixes[0] ?? null,
    endsAt: unixes[1] ?? null,
    location,
    prizePool,
    teamsAttending,
  };
}
