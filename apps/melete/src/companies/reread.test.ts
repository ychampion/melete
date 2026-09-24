/**
 * What a scan asks a model, and how often.
 *
 * A message a model has already answered for is not asked about again, so a
 * person scanning the same mailbox twice pays once. One the provider never
 * answered is asked about next time. And however many scans a person runs,
 * their scans together stop at the day's allowance, which is theirs alone.
 */
import { describe, expect, test } from 'bun:test';
import type { CompanyExtractor, ExtractionRequest, ScanExtractor } from './extract.ts';
import { FIXTURE_REFERENCE, fixtureMessages } from './fixtures.ts';
import { fixtureMailbox } from './mailbox.ts';
import { MemoryCompanyStore, type Owner } from './repository.ts';
import { runScan } from './scan.ts';
import { scriptedExtractor } from './scripted.ts';

const now = new Date(FIXTURE_REFERENCE);
const person: Owner = { spaceId: 'sp_person_home', principalId: 'own_person' };
const other: Owner = { spaceId: 'sp_other_home', principalId: 'own_other' };

/** A live extractor stand-in: it answers as the scripted one does, and counts every call. */
function counting(options: { unansweredOnce?: (request: ExtractionRequest) => boolean } = {}) {
  const script = scriptedExtractor();
  const asked: string[] = [];
  const refusedOnce = new Set<string>();
  const extractor: CompanyExtractor = {
    extract: (request) => script.extract(request),
    async forScan(): Promise<ScanExtractor> {
      const unanswered = new Set<string>();
      return {
        async extract(request) {
          asked.push(request.messageId);
          if (options.unansweredOnce?.(request) && !refusedOnce.has(request.messageId)) {
            refusedOnce.add(request.messageId);
            unanswered.add(request.messageId);
            return [];
          }
          return script.extract(request);
        },
        close: async () => {},
        unanswered,
      };
    },
  };
  return { extractor, asked };
}

const scan = (
  store: MemoryCompanyStore,
  extractor: CompanyExtractor,
  owner: Owner,
  dailyCalls?: number,
) =>
  runScan({
    store,
    mailbox: fixtureMailbox(fixtureMessages()),
    extractor,
    owner,
    now,
    ...(dailyCalls === undefined ? {} : { dailyCalls }),
  });

describe('asking a model about a mailbox', () => {
  test('a second scan does not ask about a message already answered for', async () => {
    const store = new MemoryCompanyStore();
    const { extractor, asked } = counting();
    const first = await scan(store, extractor, person);
    const firstCalls = asked.length;
    expect(firstCalls).toBeGreaterThan(0);
    const second = await scan(store, extractor, person);
    expect(asked.length).toBe(firstCalls);
    expect(second.counts.already_read).toBe(firstCalls);
    // Nothing the first scan found is lost by not asking again.
    expect(second.status).toBe('done');
    expect((await store.map(person, now)).items.length).toBe(first.itemsFound);
  });

  test('a message the provider never answered is asked about again next time', async () => {
    const store = new MemoryCompanyStore();
    let target = '';
    const { extractor, asked } = counting({
      unansweredOnce: (request) => {
        target ||= request.messageId;
        return request.messageId === target;
      },
    });
    await scan(store, extractor, person);
    const firstCalls = asked.length;
    await scan(store, extractor, person);
    expect(asked.slice(firstCalls)).toEqual([target]);
  });

  test('a person’s scans stop at their daily allowance, and another person’s do not', async () => {
    const store = new MemoryCompanyStore();
    const { extractor, asked } = counting();
    const first = await scan(store, extractor, person, 5);
    expect(asked.length).toBe(5);
    expect(first.counts.daily_allowance_reached).toBeGreaterThan(0);
    // Another of their spaces draws on the same allowance, already spent.
    await scan(store, extractor, { ...person, spaceId: 'sp_person_work' }, 5);
    expect(asked.length).toBe(5);
    // Someone else's allowance is their own.
    await scan(store, extractor, other, 5);
    expect(asked.length).toBe(10);
  });
});
