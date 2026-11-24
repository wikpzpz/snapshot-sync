#!/usr/bin/env node
import { HltvClient } from './client.ts';

const USAGE = `hltv-api — typed client for hltv.org

Usage:
  node --experimental-strip-types src/cli.ts matches [--event ID]... [--limit N]
  node --experimental-strip-types src/cli.ts results [--offset N] [--event ID] [--limit N]
  node --experimental-strip-types src/cli.ts events [--limit N]
  node --experimental-strip-types src/cli.ts event <ID> [--slug SLUG]
  node --experimental-strip-types src/cli.ts match <ID> [--slug SLUG]

Flags:
  --json            Print raw JSON (always used for event/match)
  --limit N         Slice the list to N items
  --headful         Show the Chrome window instead of running headless (browser mode)
  --mode MODE       auto (default) | curl | browser | fetch
  --cookie VALUE    Cookie header for --mode fetch
  --slug SLUG       Slug segment for event/match URLs (optional, HLTV ignores it)
`;

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

function parseArgs(argv: string[]): Args {
  const command = argv[0] ?? 'help';
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  const takesValue = new Set(['limit', 'offset', 'event', 'slug', 'cookie', 'mode']);

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split('=');
    const key = rawKey;
    if (!takesValue.has(key)) {
      flags[key] = true;
      continue;
    }
    const value = inlineValue ?? argv[++i] ?? '';
    if (key === 'event') {
      const list = (flags[key] as string[] | undefined) ?? [];
      list.push(value);
      flags[key] = list;
    } else {
      flags[key] = value;
    }
  }

  return { command, positional, flags };
}

const asList = (value: string | string[] | boolean | undefined): string[] =>
  Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];

const asNumber = (value: string | string[] | boolean | undefined): number | undefined => {
  const raw = Array.isArray(value) ? value[0] : typeof value === 'string' ? value : undefined;
  return raw == null ? undefined : Number(raw);
};

function printHuman(command: string, data: unknown): void {
  if (command === 'matches') {
    for (const match of data as Awaited<ReturnType<HltvClient['getMatches']>>) {
      const when = match.startsAt ? new Date(match.startsAt).toISOString().slice(0, 16).replace('T', ' ') : 'LIVE';
      console.log(
        `${when}  ${(match.team1?.name ?? 'TBD').padEnd(18)} vs ${(match.team2?.name ?? 'TBD').padEnd(18)} ` +
          `${match.format ?? ''} ${match.event?.name ?? ''} (#${match.id})`,
      );
    }
    return;
  }
  if (command === 'results') {
    for (const result of data as Awaited<ReturnType<HltvClient['getResults']>>) {
      const score = `${result.score?.team1 ?? '?'}-${result.score?.team2 ?? '?'}`;
      const when =
        result.startsAt != null
          ? new Date(result.startsAt).toISOString().slice(0, 16).replace('T', ' ')
          : (result.dateLabel ?? '');
      console.log(
        `${when}  ${result.team1.name} ${score} ${result.team2.name} ` +
          `[${result.map ?? ''}] ${result.event?.name ?? ''} (#${result.id})`,
      );
    }
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}

async function main(): Promise<number> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }

  const requested = typeof flags.mode === 'string' ? flags.mode : 'auto';
  const mode = (['auto', 'curl', 'browser', 'fetch'] as const).includes(requested as never)
    ? (requested as 'auto' | 'curl' | 'browser' | 'fetch')
    : 'auto';
  const client = new HltvClient({
    mode,
    cookie: typeof flags.cookie === 'string' ? flags.cookie : undefined,
    headless: flags.headful !== true,
  });

  try {
    const limit = asNumber(flags.limit);
    const json = flags.json === true || command === 'event' || command === 'match';
    const slice = <T>(items: T[]): T[] => (limit ? items.slice(0, limit) : items);

    let data: unknown;
    switch (command) {
      case 'matches':
        data = slice(await client.getMatches({ eventIds: asList(flags.event).map(Number) }));
        break;
      case 'results':
        data = slice(
          await client.getResults({
            offset: asNumber(flags.offset) ?? 0,
            eventId: asNumber(flags.event),
          }),
        );
        break;
      case 'events':
        data = await client.getEvents();
        break;
      case 'event': {
        const id = Number(positional[0]);
        if (!Number.isFinite(id)) throw new Error('event requires a numeric id');
        data = await client.getEvent(id, (flags.slug as string | undefined) ?? 'x');
        break;
      }
      case 'match': {
        const id = Number(positional[0]);
        if (!Number.isFinite(id)) throw new Error('match requires a numeric id');
        data = await client.getMatch(id, (flags.slug as string | undefined) ?? 'x');
        break;
      }
      default:
        process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }

    if (json || flags.json === true) console.log(JSON.stringify(data, null, 2));
    else if (command === 'events') {
      const events = data as Awaited<ReturnType<HltvClient['getEvents']>>;
      console.log(`Ongoing (${events.ongoing.length}):`);
      for (const event of events.ongoing) console.log(`  #${event.id} ${event.name} — ${event.location ?? ''}`);
      console.log(`Upcoming (${events.upcoming.length}):`);
      for (const event of events.upcoming) console.log(`  #${event.id} ${event.name} — ${event.location ?? ''} [${event.teams.length} teams]`);
    } else printHuman(command, data);
    return 0;
  } finally {
    await client.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  },
);
