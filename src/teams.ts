/**
 * Fill the team directory with every ranked team's country.
 *
 *   npm run teams
 *
 * The ranking page lists ~240 teams; each team page is ~5 MB but the country is
 * at ~74 KB, so this reads a 200 KB prefix per team (~60 MB in total) instead of
 * the full page. Entries already known are skipped, so re-running is cheap.
 */
import { HltvClient } from './client.ts';
import { learnEventTeams, learnRankedTeams, loadDirectory } from './directory.ts';

const client = new HltvClient({ delayMs: 250 });
try {
  const started = Date.now();
  const { added, missing } = await learnRankedTeams(client, {
    onProgress: (done, total) => {
      if (done % 25 === 0 || done === total) console.log(`  ${done}/${total} team pages`);
    },
  });
  console.log('crawling event attendee lists…');
  const events = await learnEventTeams(client, {
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) console.log(`  event pages ${done}/${total}`);
    },
  });
  console.log(`event teams: +${events.added} (from ${events.known} attending teams)`);

  const directory = await loadDirectory();
  const countries = new Map<string, number>();
  for (const team of Object.values(directory)) {
    if (team.country) countries.set(team.country, (countries.get(team.country) ?? 0) + 1);
  }
  console.log(
    `learned ${added} teams in ${((Date.now() - started) / 1000).toFixed(1)}s ` +
      `(${Object.keys(directory).length} known, ${missing} ranked still unknown)`,
  );
  console.log(
    'top countries:',
    [...countries.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
  );
} finally {
  await client.close();
}
