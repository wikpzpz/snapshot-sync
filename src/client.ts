import { FeedHttp } from './http.ts';
import type { HttpClientOptions } from './http.ts';
import { parseEventDetail, parseEvents, parseMatchCards, parseMatchDetail, parseResults } from './parse.ts';
import { parseTeamPage, parseTeamSearch } from './team.ts';
import { parseMatchTeams } from './directory.ts';
import type {
  EventDetail,
  EventSummary,
  MatchCard,
  MatchDetail,
  MatchResult,
  TeamDirectoryEntry,
  TeamSearchResult,
  TeamUpcoming,
} from './types.ts';

export interface ResultsOptions {
  /** Server-side pagination; the source pages results in steps of 100. */
  offset?: number;
  /** Only results of one event (/results?event={id}). */
  eventId?: number;
  /** Only matches on one map or favoured/unfavoured filters the source supports. */
  extraQuery?: Record<string, string>;
}

export interface MatchesOptions {
  /** Only keep matches of these events (filtered client-side). */
  eventIds?: number[];
}

/**
 * Typed client over the source's public web endpoints.
 *
 * Every method maps onto one HTML document; the parsers in `parse.ts` turn the
 * markup into the interfaces in `types.ts`. See docs/ENDPOINTS.md for the
 * reverse-engineering notes (Cloudflare, auth-only /api/, scorebot, etc.).
 */
export class FeedClient {
  readonly http: FeedHttp;

  constructor(options: HttpClientOptions = {}) {
    this.http = new FeedHttp(options);
  }

  /**
   * Live + upcoming matches: https://www.the source site/matches
   *
   * `?event=` is ignored server-side (the page ships all 200+ cards and filters
   * with JS), so `eventIds` is applied to the parsed cards instead.
   */
  async getMatches(options: MatchesOptions = {}): Promise<MatchCard[]> {
    const cards = parseMatchCards(await this.http.getHtml('/matches'));
    const eventIds = options.eventIds?.filter((id) => Number.isFinite(id)) ?? [];
    if (!eventIds.length) return cards;
    const wanted = new Set(eventIds);
    return cards.filter((card) => card.event?.id != null && wanted.has(card.event.id));
  }

  /** Finished matches: https://www.the source site/results?offset=N */
  async getResults(options: ResultsOptions = {}): Promise<MatchResult[]> {
    const params = new URLSearchParams();
    params.set('offset', String(options.offset ?? 0));
    if (options.eventId) params.set('event', String(options.eventId));
    for (const [key, value] of Object.entries(options.extraQuery ?? {})) params.set(key, value);
    const html = await this.http.getHtml(`/results?${params.toString()}`);
    return parseResults(html);
  }

  /** Ongoing and upcoming events: https://www.the source site/events */
  async getEvents(): Promise<{ ongoing: EventSummary[]; upcoming: EventSummary[] }> {
    return parseEvents(await this.http.getHtml('/events'));
  }

  /** https://www.the source site/events/{id}/{slug} */
  async getEvent(id: number, slug = 'x'): Promise<EventDetail> {
    const path = `/events/${id}/${slug}`;
    return parseEventDetail(await this.http.getHtml(path), id, FeedHttp.resolve(path));
  }

  /** https://www.the source site/matches/{id}/{slug} */
  async getMatch(id: number, slug = 'x'): Promise<MatchDetail> {
    const path = `/matches/${id}/${slug}`;
    return parseMatchDetail(await this.http.getHtml(path), id, FeedHttp.resolve(path));
  }

  /**
   * The source's per-map stats page: the only page that prints assists and
   * headshot kills. It is bot-checked harder than match pages.
   * https://www.the source site/stats/matches/mapstatsid/{id}/{slug}
   */
  async getMapStatsPage(mapStatsId: number, slug = 'x'): Promise<string> {
    return this.http.getHtml(`/stats/matches/mapstatsid/${mapStatsId}/${slug}`);
  }

  /**
   * The two teams of a match with their region/country.
   * https://www.the source site/matches/{id}/{slug} — the only cheap source of team country.
   */
  async getMatchTeams(id: number, slug = 'x'): Promise<TeamDirectoryEntry[]> {
    return parseMatchTeams(await this.http.getHtml(`/matches/${id}/${slug}`));
  }

  /** Team lookup: https://www.the source site/search?query=<q> */
  async searchTeams(query: string): Promise<TeamSearchResult[]> {
    return parseTeamSearch(await this.http.getHtml(`/search?query=${encodeURIComponent(query)}`));
  }

  /** https://www.the source site/team/{id}/{slug} — fixture table plus the events the team is attending. */
  async getTeamUpcoming(id: number, slug = 'x'): Promise<TeamUpcoming> {
    const path = `/team/${id}/${slug}`;
    return parseTeamPage(await this.http.getHtml(path), id, FeedHttp.resolve(path));
  }

  async close(): Promise<void> {
    await this.http.close();
  }
}
