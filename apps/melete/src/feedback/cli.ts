/**
 * Read problem reports from the database, for whoever is fixing them.
 *
 *   bun run feedback                 open and in-progress reports, newest first
 *   bun run feedback list --all      every report
 *   bun run feedback list --status fixed
 *   bun run feedback show FB-7K3Q    one report as Markdown
 *
 * Reads DATABASE_URL, the same database the service uses. It only reads.
 */
import { type FeedbackStatus, feedbackStatus } from '@melete/contracts';
import { openDatabase } from '../db/client.ts';
import { reportLine, reportMarkdown } from './markdown.ts';
import { FeedbackStore } from './service.ts';

const USAGE = `Usage:
  bun run feedback [list] [--all | --status open|fixing|fixed|wontfix]
  bun run feedback show FB-XXXX
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main(argv: string[]): Promise<void> {
  const [command = 'list', ...rest] = argv;
  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  if (command !== 'list' && command !== 'show' && !command.startsWith('--'))
    fail(`Unknown command "${command}".\n\n${USAGE}`);
  const url = process.env.DATABASE_URL;
  if (!url) fail('Set DATABASE_URL to the database the service uses.');
  const handle = openDatabase(url, 1);
  try {
    const store = new FeedbackStore(handle.db);
    const installationId = await store.installation();
    if (!installationId) fail('This database has no installation yet.');
    const scope = { installationId };
    if (command === 'show') {
      const id = rest[0];
      if (!id) fail(`Name a report.\n\n${USAGE}`);
      const report = await store.get(scope, id);
      if (!report) fail(`No report ${id}.`);
      process.stdout.write(reportMarkdown(report));
      return;
    }
    const args = command === 'list' ? rest : argv;
    const statusAt = args.indexOf('--status');
    let status: FeedbackStatus | undefined;
    if (statusAt >= 0) {
      const parsed = feedbackStatus.safeParse(args[statusAt + 1]);
      if (!parsed.success) fail(`--status takes open, fixing, fixed or wontfix.\n\n${USAGE}`);
      status = parsed.data;
    }
    const all = args.includes('--all');
    let reports = await store.list(scope, status);
    if (!all && statusAt < 0)
      reports = reports.filter((report) => report.status === 'open' || report.status === 'fixing');
    if (reports.length === 0) {
      process.stdout.write('No reports.\n');
      return;
    }
    for (const report of reports) process.stdout.write(`${reportLine(report)}\n`);
    process.stdout.write('\nRead one with: bun run feedback show FB-XXXX\n');
  } finally {
    await handle.close();
  }
}

await main(process.argv.slice(2)).catch((error: unknown) =>
  fail(`Could not read reports: ${error instanceof Error ? error.message : String(error)}`),
);
