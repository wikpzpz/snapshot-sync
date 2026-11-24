// `cheerio/slim` has no Node-only dependencies, so the same parsers run in Node
// and in the Cloudflare Worker bundle (see deploy/api.js).
import { load } from 'cheerio/slim';
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import type {
  EventDetail,
  EventRef,
  EventSummary,
  MapScore,
  MatchCard,
  MatchDetail,
  MatchResult,
  TeamRef,
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

/** Absolute image URL for HLTV's protocol-relative/relative `src`s. */
/**
 * Strip any origin from an href.
 *
 * Pages rendered by microlink come back with absolute URLs (`https://www.hltv.org/team/6667/faze`),
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

/** Cards from https://www.hltv.org/matches */
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
      score: null,
    });
  });

  return cards;
}

/** Entries from https://www.hltv.org/results?offset=N */
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

/** Ongoing + upcoming events from https://www.hltv.org/events */
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

/** https://www.hltv.org/matches/{id}/{slug} */
export function parseMatchDetail(html: string, id: number, url: string): MatchDetail {
  const $ = load(html);

  const teamHrefs: number[] = [];
  $('a[href*="/team/"]').each((_, el) => {
    const teamId = toInt(pathOf($(el).attr('href')).match(TEAM_HREF)?.[1] ?? null);
    if (teamId && !teamHrefs.includes(teamId)) teamHrefs.push(teamId);
  });

  const team1 = headerTeam($, 1, true);
  const team2 = headerTeam($, 2, true);
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

  const title = clean($('title').first().text())?.replace(/\s*\|\s*HLTV\.org\s*$/i, '') ?? null;
  const startsAt =
    toInt($('.date[data-unix]').first().attr('data-unix')) ??
    unixAt($, $('.match-page').length ? $('.match-page') : $('body'));

  return {
    id,
    url,
    title,
    event: eventRef($, eventHref, eventName, imgUrl(eventLogo.attr('src'))),
    startsAt,
    team1,
    team2,
    maps,
  };
}

/** https://www.hltv.org/events/{id}/{slug} */
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
