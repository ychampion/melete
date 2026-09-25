/**
 * The world a fresh mock starts in: one space, three connections, a handful of
 * knowledge records, and the built-in skills. Enough for every screen in the
 * reference client to have something honest to show.
 */
import { ID_PREFIXES, SCHEMA_VERSION } from '@melete/contracts';
import { newId, type Store } from './store.ts';

const DAY = '2026-09-01';

type SeedRecord = {
  path: string;
  title: string;
  type: 'fact' | 'preference' | 'decision' | 'procedure' | 'reference' | 'event';
  status: 'active' | 'superseded' | 'retracted' | 'disputed';
  confidence: 'high' | 'medium' | 'low';
  asserted_by: 'user' | 'agent' | 'document' | 'tool';
  quote: string;
  body: string;
  tags: string[];
};

const RECORDS: SeedRecord[] = [
  {
    path: 'knowledge/home-city.md',
    title: 'Home city',
    type: 'fact',
    status: 'active',
    confidence: 'high',
    asserted_by: 'user',
    quote: 'I live in Bristol.',
    body: 'Bristol. Times, bookings and directions start from here unless you say otherwise.',
    tags: ['home'],
  },
  {
    path: 'knowledge/landlord-contact.md',
    title: 'Landlord contact',
    type: 'fact',
    status: 'active',
    confidence: 'medium',
    asserted_by: 'user',
    quote: 'She never picks up. Email works.',
    body: 'Reach the landlord at landlord@example.com. Calls go to voicemail and are not returned.',
    tags: ['flat', 'contacts'],
  },
  {
    path: 'knowledge/heating-fault.md',
    title: 'Heating fault',
    type: 'event',
    status: 'active',
    confidence: 'high',
    asserted_by: 'document',
    quote: 'Reported: 12 August. Reference HT-4471.',
    body: 'The heating in the front room has been out since 10 August. Reference HT-4471.',
    tags: ['flat', 'repairs'],
  },
  {
    path: 'knowledge/old-address.md',
    title: 'Previous address',
    type: 'fact',
    status: 'retracted',
    confidence: 'low',
    asserted_by: 'agent',
    quote: '',
    body: 'Retracted: this address was read out of a stale signature block and was never confirmed.',
    tags: ['contacts'],
  },
  {
    path: 'knowledge/reply-tone.md',
    title: 'Reply style',
    type: 'procedure',
    status: 'active',
    confidence: 'medium',
    asserted_by: 'user',
    quote: 'Keep it to five lines and always give the date.',
    body: 'Open with the reference, give the date of the last contact, ask one question, sign off.',
    tags: ['writing'],
  },
];

export type SeedResult = {
  spaceId: string;
  connections: Record<'inbox' | 'outbox' | 'test', string>;
};

export function seed(store: Store): SeedResult {
  const now = store.now().toISOString();

  const spaceId = newId(ID_PREFIXES.space);
  store.spaces.set(spaceId, {
    id: spaceId,
    name: 'personal',
    kind: 'personal',
    audience: 'owner',
    git_path: '/data/spaces/personal',
    created_at: now,
  });

  const connection = (
    provider: 'imap' | 'smtp' | 'test',
    label: string,
    scopes: string[],
    health: 'ok' | 'degraded' | 'unknown',
  ): string => {
    const id = newId(ID_PREFIXES.connection);
    store.connections.set(id, {
      id,
      space_id: spaceId,
      provider,
      label,
      secret_ref: newId(ID_PREFIXES.secret),
      scopes,
      status: 'active',
      health,
      last_checked_at: now,
      created_at: now,
    });
    return id;
  };

  const connections = {
    inbox: connection('imap', 'inbox', ['mail.read', 'mail.search'], 'ok'),
    outbox: connection('smtp', 'outbox', ['mail.send'], 'ok'),
    test: connection('test', 'test-destination', ['test.write'], 'unknown'),
  };

  for (const record of RECORDS) {
    const id = newId(ID_PREFIXES.knowledge);
    store.knowledge.set(id, {
      id,
      space_id: spaceId,
      path: record.path,
      body: record.body,
      frontmatter: {
        id,
        title: record.title,
        space: 'personal',
        audience: 'private',
        type: record.type,
        status: record.status,
        confidence: record.confidence,
        asserted_by: record.asserted_by,
        source: {
          kind: record.asserted_by === 'document' ? 'file' : 'statement',
          ref: record.asserted_by === 'document' ? 'raw/ht-4471.eml' : 'session/2026-09-01',
          quote: record.quote,
          sha256: null,
        },
        observed_at: DAY,
        valid_from: DAY,
        valid_until: null,
        supersedes: [],
        superseded_by: null,
        created: DAY,
        updated: DAY,
        tags: record.tags,
        links: [],
        schema_version: SCHEMA_VERSION,
      },
    });
  }

  const skill = (
    name: string,
    description: string,
    triggers: string[],
    tools: string[],
    spaceScoped: boolean,
  ) => {
    const id = newId(ID_PREFIXES.skill);
    store.skills.set(id, {
      id,
      space_id: spaceScoped ? spaceId : null,
      path: spaceScoped ? `skills/${name}.md` : `builtin/${name}.md`,
      enabled: true,
      frontmatter: { name, description, triggers, tools, max_tokens: 400 },
    });
  };

  skill(
    'email-reply',
    'Draft a reply to a message already in the inbox and send it once approved.',
    ['reply', 'respond', 'email back'],
    ['email.search', 'email.send'],
    false,
  );
  skill(
    'chase-repair',
    'Follow up on an open repair by reference number.',
    ['repair', 'heating', 'chase'],
    ['email.search', 'email.send'],
    true,
  );

  return { spaceId, connections };
}
