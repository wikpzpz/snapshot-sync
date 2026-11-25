/** Reverse-engineered domain model for the the source site public web endpoints. */

export type MatchStatus = 'upcoming' | 'live' | 'finished';

export interface TeamRef {
  id: number | null;
  name: string;
  logo: string | null;
  /** Region/country, filled in by the API from the team directory when known. */
  country?: string | null;
  /** 30x20 flag that matches `country`. */
  flag?: string | null;
}

export interface EventRef {
  id: number | null;
  name: string;
  logo: string | null;
}

/** A card from https://www.the source site/matches (live + upcoming). */
export interface MatchCard {
  id: number;
  url: string;
  status: MatchStatus;
  /** Unix ms, taken from `.match-time[data-unix]`. Null for live matches. */
  startsAt: number | null;
  /** e.g. "bo1", "bo3". */
  format: string | null;
  stage: string | null;
  /** 0-5 stars, from `.match-rating i.fa-star:not(.faded)`. */
  stars: number | null;
  event: EventRef | null;
  team1: TeamRef | null;
  team2: TeamRef | null;
  /** Rounds of the map being played right now, e.g. `{ team1: 9, team2: 6 }`. */
  mapScore: { team1: number; team2: number } | null;
  /** Set by /api/country: which side(s) belong to the requested country. */
  countryTeam?: 'team1' | 'team2' | 'both' | null;
}

/** An entry from https://www.the source site/results (finished matches). */
export interface MatchResult {
  id: number;
  url: string;
  /** Group heading of `.results-sublist`, e.g. "24th of November 2026". */
  dateLabel: string | null;
  startsAt: number | null;
  /** Series score (map score for a bo1), from `.result-score`. */
  score: { team1: number | null; team2: number | null } | null;
  team1: TeamRef & { won: boolean };
  team2: TeamRef & { won: boolean };
  event: EventRef | null;
  /** Map the result was played on, when the source shows one ("mrg", "inf", ...). */
  map: string | null;
  starred: boolean;
}

/** One line of the veto box, e.g. "3. SAW Youngsters picked Anubis". */
export interface VetoStep {
  order: number;
  /** Team name as printed, or null for "Dust2 was left over". */
  team: string | null;
  action: 'picked' | 'removed' | 'left over';
  map: string;
}

/** A player in a team's lineup box, before any stats. */
export interface LineupPlayer {
  id: number | null;
  /** In-game name, e.g. "tuxa". */
  nick: string;
  /** Real name when the player photo carries it, e.g. "Daniel Esteves". */
  name: string | null;
  photo: string | null;
  /** Country from the flag next to the photo, e.g. "Portugal". */
  country: string | null;
  /** Role pill, e.g. "Main AWPer". */
  role: string | null;
}

export interface TeamLineup {
  team: TeamRef;
  /** Source's ranking badge text, e.g. "#152". */
  ranking: string | null;
  players: LineupPlayer[];
}

/** One row of the match stats table (the "Both" view, all maps). */
export interface PlayerStat {
  playerId: number | null;
  nick: string;
  country: string | null;
  kills: number | null;
  deaths: number | null;
  /** Kill/death difference. */
  kdDiff: number | null;
  /** Round swing, e.g. "+3.47%". */
  swing: string | null;
  adr: number | null;
  /** Percent, e.g. 66.2. */
  kast: number | null;
  /** Round rating, e.g. 1.22. */
  rating: number | null;
  /** Assists, when the per-map stats page could be read. */
  assists: number | null;
  /** Assists that came off a flash. */
  flashAssists: number | null;
  /** Headshot kills, and their share of `kills` (0-100). */
  headshots: number | null;
  headshotPct: number | null;
}

export interface TeamStats {
  team: TeamRef;
  players: PlayerStat[];
}

/** One map's stats table, from its tab in the match page's stats box. */
export interface MapStats {
  /** Map name as printed, e.g. "Anubis". */
  name: string;
  /** Source map-stats page id, used to fetch assists and headshots. */
  mapStatsId: number | null;
  teams: TeamStats[];
}

export interface MatchVeto {
  /** Free-text description above the veto, e.g. "Best of 3 (Online)". */
  text: string | null;
  steps: VetoStep[];
}

export interface MapScore {
  name: string;
  team1: number | null;
  team2: number | null;
  /** "won" / "lost" / null when the map is not finished. */
  winner: 1 | 2 | null;
}

/** https://www.the source site/matches/{id}/{slug} */
export interface MatchDetail {
  id: number;
  url: string;
  title: string | null;
  event: EventRef | null;
  startsAt: number | null;
  team1: (TeamRef & { score: number | null; won: boolean }) | null;
  team2: (TeamRef & { score: number | null; won: boolean }) | null;
  maps: MapScore[];
  /** "bo1" / "bo3" / "bo5", from the veto box description. */
  format: string | null;
  veto: MatchVeto | null;
  /** The lineup boxes, in page order (team1 then team2). */
  lineups: TeamLineup[];
  /** The match stats table, one entry per team. */
  stats: TeamStats[];
  /** The same tables per map, in map order. */
  mapStats: MapStats[];
  /** True while the match has not started, so `lineups` is the expected lineup. */
  expected: boolean;
}

export interface EventSummary {
  id: number;
  url: string;
  name: string;
  logo: string | null;
  /** ISO country name from the location row, e.g. "Singapore". */
  location: string | null;
  country: string | null;
  /** Team names shown as attending on the card. */
  teams: string[];
  ongoing: boolean;
}

/** https://www.the source site/events/{id}/{slug} */
export interface EventDetail {
  id: number;
  url: string;
  name: string;
  logo: string | null;
  startsAt: number | null;
  endsAt: number | null;
  location: string | null;
  prizePool: string | null;
  teamsAttending: number | null;
}

export interface MatchesOptions {
  /**
   * Only keep matches of these events. the source's own `?event=` filter runs in the
   * browser, so the page always returns every match and filtering happens here.
   */
  eventIds?: number[];
}

/** A team returned by https://www.the source site/search?query=<q> */
export interface TeamSearchResult {
  id: number;
  name: string;
  url: string;
  logo: string | null;
}

/** An event a team is attending, from the team page's `upcoming-events-holder` box. */
export interface TeamEvent {
  id: number;
  url: string;
  name: string;
  logo: string | null;
  startsAt: number | null;
  endsAt: number | null;
}

/** A team plus the country/region shown on its profile page. */
export interface TeamProfile extends TeamSearchResult {
  /** e.g. "Europe", "Brazil", "France" — the source labels teams by region or country. */
  country: string | null;
  /** Flag image from `/img/static/flags/30x20/XX.gif`. */
  flag: string | null;
}

/**
 * A team's region/country, resolved from the match page's `teamsBox` flags
 * (`/img/static/flags/300x200/EU.png` → alt "Europe").
 */
export interface TeamDirectoryEntry {
  name: string;
  /** Country name, or a region label such as "Europe" / "Other" / "World". */
  country: string | null;
  /** 30x20 flag gif, derived from the 300x200 banner. */
  flag: string | null;
  /** the source team id, when the entry came from a match page or the ranking. */
  id?: number | null;
  /** Team logo, when known. */
  logo?: string | null;
  /**
   * Majority nationality of the starting five — the "core". This differs from
   * `country` (the org/region the source prints): fnatic's region is "Ukraine" while
   * its core can be Swedish. Country views prefer this when present.
   */
  core?: string | null;
  coreCount?: number | null;
  coreSize?: number | null;
}

/** https://www.the source site/team/{id}/{slug} */
export interface TeamUpcoming {
  team: TeamProfile;
  upcoming: MatchCard[];
  events: TeamEvent[];
}
