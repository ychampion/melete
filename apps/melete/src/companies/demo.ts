/**
 * Run a scan over the demonstration mailbox and print the map.
 *
 * `bun run companies:demo` needs nothing: no database, no key, no inbox. It
 * loads the forty invented messages, runs the same scan the service runs, and
 * writes the map as JSON, which is what the screens read and what a recording
 * shows.
 *
 * With `DATABASE_URL` set it writes the same map into Postgres instead, against
 * a space and a principal you name, so a development database has something
 * real to serve over the HTTP surface.
 */

import { openDatabase } from '../db/client.ts';
import { FIXTURE_REFERENCE, fixtureMessages } from './fixtures.ts';
import { fixtureMailbox } from './mailbox.ts';
import {
  type CompanyStore,
  contractMap,
  MemoryCompanyStore,
  PostgresCompanyStore,
} from './repository.ts';
import { runScan } from './scan.ts';
import { scriptedExtractor } from './scripted.ts';

export type DemoOptions = {
  spaceId: string;
  principalId: string;
  /** The instant the fixture mailbox is dated against; today, by default. */
  reference?: string;
  store?: CompanyStore;
};

export async function runDemoScan(options: DemoOptions) {
  const owner = { spaceId: options.spaceId, principalId: options.principalId };
  const reference = options.reference ?? new Date().toISOString();
  const store = options.store ?? new MemoryCompanyStore();
  const outcome = await runScan({
    store,
    mailbox: fixtureMailbox(fixtureMessages(reference)),
    extractor: scriptedExtractor(),
    owner,
    now: new Date(reference),
  });
  const map = await store.map(owner, new Date(reference));
  return { outcome, map, contract: contractMap(map) };
}

if (import.meta.main) {
  const args = new Map<string, string>();
  for (const argument of process.argv.slice(2)) {
    const [key, value] = argument.replace(/^--/, '').split('=');
    if (key) args.set(key, value ?? 'true');
  }
  const spaceId = args.get('space') ?? 'sp_01J0000000000000000000000A';
  const principalId = args.get('principal') ?? 'own_01J0000000000000000000000B';
  const reference = args.get('reference') ?? (args.has('fixed') ? FIXTURE_REFERENCE : undefined);
  const url = args.get('database-url') ?? process.env.DATABASE_URL;
  const handle = url ? openDatabase(url) : null;
  try {
    const result = await runDemoScan({
      spaceId,
      principalId,
      reference,
      store: handle ? new PostgresCompanyStore(handle.db) : undefined,
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          scan: {
            id: result.outcome.id,
            status: result.outcome.status,
            messages_seen: result.outcome.messagesSeen,
            items_found: result.outcome.itemsFound,
            counts: result.outcome.counts,
          },
          // The promise counts are part of the totals now, so the map below is
          // the whole answer and nothing is reported beside it.
          map: result.contract,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await handle?.close();
  }
}
