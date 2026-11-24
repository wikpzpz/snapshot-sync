import { load } from 'cheerio/slim';
import type { Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { clean, imgUrl, pathOf, toInt } from './parse.ts';
import type {
  EventRef,
  MatchCard,
  TeamEvent,
  TeamProfile,
  TeamRef,
  TeamSearchResult,
  TeamUpcoming,
} from './types.ts';

const TEAM_HREF = /^\/team\/(\d+)\//;

/**
 * Country/flag/logo from the head of https://www.hltv.org/team/{id}/{slug}.
 *
 * Only the first ~100 KB matter, so callers can pass `maxBytes` and skip the
 * other 5 MB of match history.
 */
export function parseTeamProfileHead(html: string): {
  country: string | null;
  flag: string | null;
  logo: string | null;
} {
  const $ = load(html);
  const box = $('.team-country').first();
  return {
    country: clean(box.find('img').first().attr('alt')) ?? clean(box.text()) ?? null,
    flag: imgUrl(box.find('img').first().attr('src')),
    logo: imgUrl($('.teamlogo, .team-logo img').first().attr('src')),
  };
}

/**
 * Every ranked team: https://www.hltv.org/ranking/teams lists ~240 in one page.
 *
 * The block also shows the five starters with their flags, which is the only
 * cheap source of a team's *core* nationality (its org region is a separate,
 * often misleading label — fnatic says "Ukraine", Ninjas in Pyjamas "Europe").
 */
export function parseRanking(html: string): Array<{ id: number; name: string; players: string[] }> {
  const $ = load(html);
  const teams: Array<{ id: number; name: string; players: string[] }> = [];
  const seen = new Set<number>();

  $('.ranked-team').each((_, el) => {
    const node = $(el);
    const href = pathOf(node.find('a[href*="/team/"]').first().attr('href'));
    const id = toInt(href.match(TEAM_HREF)?.[1] ?? null);
    const name = clean(node.find('.name').first().text());
    if (!id || !name || seen.has(id)) return;
    seen.add(id);
    const players = node
      .find('.lineup img[src*="/flags/"], .rankingNicknames img[src*="/flags/"], .nick img[src*="/flags/"]')
      .map((__, img) => clean($(img).attr('alt')))
      .get()
      .filter((text): text is string => !!text);
    teams.push({ id, name, players });
  });

  return teams;
}

/** Majority nationality of a roster — "Swedish core" means a Swedish majority. */
export function coreCountry(players: string[]): { country: string | null; count: number; size: number } {
  const counts = new Map<string, number>();
  for (const country of players) counts.set(country, (counts.get(country) ?? 0) + 1);
  let best: [string, number] | null = null;
  for (const entry of counts) if (!best || entry[1] > best[1]) best = entry;
  if (!best || best[1] * 2 <= players.length) return { country: null, count: best?.[1] ?? 0, size: players.length };
  return { country: best[0], count: best[1], size: players.length };
}
const MATCH_HREF = /^\/matches\/(\d+)\//;
const EVENT_HREF = /^\/events\/(\d+)\//;

/**
 * Team results from https://www.hltv.org/search?query=<q>
 *
 * Search hits are plain anchors carrying the result type:
 * `<a href="/team/6667/faze" data-result-type="TEAM" data-result-id="6667">FaZe</a>`
 */
export function parseTeamSearch(html: string): TeamSearchResult[] {
  const $ = load(html);
  const teams: TeamSearchResult[] = [];
  const seen = new Set<number>();

  $('a[data-result-type="TEAM"]').each((_, el) => {
    const node = $(el);
    const href = pathOf(node.attr('href'));
    const id = toInt(node.attr('data-result-id')) ?? toInt(href.match(TEAM_HREF)?.[1] ?? null);
    const name = clean(node.text()) ?? clean(node.find('img').first().attr('alt'));
    if (!id || !name || seen.has(id)) return;
    seen.add(id);
    teams.push({ id, name, url: `https://www.hltv.org${href}`, logo: imgUrl(node.find('img').first().attr('src')) });
  });

  return teams;
}

function sideRef(row: Cheerio<AnyNode>, which: 'team-1' | 'team-2'): TeamRef | null {
  const nameNode = row.find(`a.team-name.${which}`).first();
  const flex = nameNode.closest('.team-flex');
  const name = clean(nameNode.text()) ?? clean(flex.find('img').first().attr('alt'));
  if (!name) return null;
  const href = pathOf(flex.find('a[href*="/team/"]').first().attr('href') ?? nameNode.attr('href'));
  return {
    id: toInt(href.match(TEAM_HREF)?.[1] ?? null),
    name,
    logo: imgUrl(flex.find('img').first().attr('src')),
  };
}

/**
 * https://www.hltv.org/team/{id}/{slug}
 *
 * The page contains two `table.match-table` blocks — "Upcoming matches" (rows
 * carry a `.matchpage-button`) and "Recent results" (no button) — plus two
 * `.upcoming-events-holder` boxes: the upcoming one and a long historical list.
 * Only upcoming data is kept.
 */
export function parseTeamPage(html: string, id: number, url: string): TeamUpcoming {
  const $ = load(html);

  const titleName = clean($('title').first().text())?.replace(/\s*\|\s*HLTV\.org\s*$/i, '') ?? null;
  const name =
    clean($('.profile-team-name, .team-profile-name, h1').first().text()) ??
    (titleName ? titleName.replace(/\s*team profile$/i, '') : null) ??
    `team ${id}`;
  const logoImg = $('img')
    .filter((_, el) => /teamlogo/.test($(el).attr('src') ?? ''))
    .first();

  // The profile header shows a region/country flag: `<div class="team-country">
  // <img class="flag" alt="Europe" src="/img/static/flags/30x20/EU.gif">Europe</div>`
  const countryNode = $('.team-country').first();
  const countryFlag = countryNode.find('img.flag').first();
  const country =
    clean(countryFlag.attr('title')) ??
    clean(countryFlag.attr('alt')) ??
    clean(countryNode.text());
  const flag = imgUrl(countryFlag.attr('src'));

  const profile: TeamProfile = {
    id,
    name,
    url,
    logo: imgUrl(logoImg.attr('src')),
    country,
    flag,
  };

  const upcoming: MatchCard[] = [];
  const seen = new Set<number>();

  $('table.match-table').each((_, tableEl) => {
    const table = $(tableEl);
    if (!table.find('.matchpage-button').length) return; // "Recent results" table

    const eventAnchor = table.find('thead a[href*="/events/"]').first();
    const eventHref = pathOf(eventAnchor.attr('href'));
    const eventName = clean(eventAnchor.text()) ?? clean(table.find('thead th').last().text());
    const event: EventRef | null = eventName
      ? { id: toInt(eventHref.match(EVENT_HREF)?.[1] ?? null), name: eventName, logo: null }
      : null;

    table.find('tr.team-row').each((__, rowEl) => {
      const row = $(rowEl);
      const href = pathOf(row.find('a[href*="/matches/"]').first().attr('href'));
      const matchId = toInt(href.match(MATCH_HREF)?.[1] ?? null);
      if (!matchId || seen.has(matchId)) return;
      seen.add(matchId);

      const scoreSpans = row.find('.score-cell .score');
      const score1 = toInt(scoreSpans.eq(0).text());
      const score2 = toInt(scoreSpans.eq(1).text());

      upcoming.push({
        id: matchId,
        url: `https://www.hltv.org${href}`,
        status: 'upcoming',
        startsAt: toInt(row.find('.date-cell [data-unix]').first().attr('data-unix')),
        // The fixture table has no series-format column.
        format: null,
        stage: null,
        stars: null,
        event,
        team1: sideRef(row, 'team-1'),
        team2: sideRef(row, 'team-2'),
        score: score1 != null && score2 != null ? { team1: score1, team2: score2 } : null,
      });
    });
  });

  const now = Date.now();
  const events: TeamEvent[] = [];
  const seenEvents = new Set<number>();
  $('.upcoming-events-holder a[href*="/events/"]').each((_, el) => {
    const node = $(el);
    const href = pathOf(node.attr('href'));
    const eventId = toInt(href.match(EVENT_HREF)?.[1] ?? null);
    const eventName = clean(node.find('.eventbox-eventname').first().text()) ?? clean(node.text());
    if (!eventId || !eventName || seenEvents.has(eventId)) return;

    const unixes = node
      .find('[data-unix]')
      .map((__, span) => toInt($(span).attr('data-unix')))
      .get()
      .filter((value): value is number => value != null);
    const endsAt = unixes[unixes.length - 1] ?? null;
    // The second box is a historical list; keep only events that are still on.
    if (endsAt != null && endsAt < now) return;

    seenEvents.add(eventId);
    events.push({
      id: eventId,
      url: `https://www.hltv.org${href}`,
      name: eventName,
      logo: imgUrl(node.find('.eventbox-eventlogo img, img').first().attr('src')),
      startsAt: unixes[0] ?? null,
      endsAt,
    });
  });

  upcoming.sort((a, b) => (a.startsAt ?? 0) - (b.startsAt ?? 0));
  events.sort((a, b) => (a.startsAt ?? 0) - (b.startsAt ?? 0));

  return { team: profile, upcoming, events };
}
