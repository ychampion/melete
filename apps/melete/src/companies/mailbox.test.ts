/**
 * The seam where the scan meets a real mailbox.
 *
 * This is the part of the company map that has no live inbox to prove itself against,
 * so it is proved against a real `EmailConnector` holding a transport double.
 * Everything between the scan and the transport is the shipping code: the
 * connector, its sealed-credential wrapper, its action context check and its
 * inbox hygiene all run exactly as they do in production.
 *
 * What the tests are for is the claim the design rests on: the scan is not a
 * second way into a person's mail. It asks the connector the same question the
 * agent asks, over the same entry point, and it cannot ask for anything else.
 */

import { describe, expect, test } from 'bun:test';
import { simpleParser } from 'mailparser';
import { EmailConnector } from '../connectors/email.ts';
import {
  type EmailConnection,
  type MailMessage,
  type MailTransport,
  type OutgoingMail,
  toMailMessage,
} from '../connectors/mail-transport.ts';
import { ConnectorRegistry } from '../connectors/registry.ts';
import type { SecretAccess } from '../connectors/secrets.ts';
import { FIXTURE_MESSAGE_COUNT, fixtureMailMessages, fixtureMessages } from './fixtures.ts';
import { connectorMailbox, fixtureMailbox } from './mailbox.ts';
import { prefilter } from './prefilter.ts';
import { MemoryCompanyStore } from './repository.ts';
import { runScan } from './scan.ts';
import { scriptedExtractor } from './scripted.ts';

const SPACE = 'spc_test';
const CONNECTION = 'con_test';
const UNDATED = '2026-09-18T09:00:00.000Z';

const config: EmailConnection = {
  id: CONNECTION,
  spaceId: SPACE,
  secretRef: 'sec_private',
  username: 'accounts@thackeraylane.example',
  from: 'accounts@thackeraylane.example',
  imap: { host: 'imap.example.test', port: 993, secure: true },
  smtp: { host: 'smtp.example.test', port: 465, secure: true },
};
const secret: SecretAccess = {
  withSecret: async (_id, _space, use) => use('app-password-that-never-leaks'),
};

const message = (
  uid: number,
  subject: string,
  text: string,
  date: string | null = '2026-09-15T10:00:00.000Z',
  from = 'Nimbus Ledger <billing@nimbusledger.example>',
): MailMessage => ({
  uid,
  message_id: `<${uid}@nimbusledger.example>`,
  from,
  to: 'accounts@thackeraylane.example',
  subject,
  text,
  html: '<p>ignored</p>',
  date,
});

class MailDouble implements MailTransport {
  searches = 0;
  sends = 0;
  lastLimit = 0;
  messages: MailMessage[] = [
    message(1, 'Receipt for your plan', 'Your monthly subscription of GBP 148.00 was charged.'),
    message(2, 'Your one-time passcode', 'Your OTP is 449120. Do not share it with anyone.'),
    message(
      3,
      'Invoice 2026-121',
      'Invoice 2026-121 for GBP 6,750.00 is now overdue.',
      '2026-09-16T08:00:00.000Z',
      'Alder and Vine <finance@aldervine.example>',
    ),
    // A message the transport could not date.
    message(4, 'A change to your price', 'From 1 November the price is going up.', null),
    // A message with no Message-ID cannot be cited, so it cannot be scanned.
    { ...message(5, 'Anonymous', 'No identity here.'), message_id: null },
  ];
  async search(_query: string, limit: number): Promise<MailMessage[]> {
    this.searches++;
    this.lastLimit = limit;
    return this.messages;
  }
  async read(uid: number): Promise<MailMessage | null> {
    return this.messages.find((entry) => entry.uid === uid) ?? null;
  }
  async send(outgoing: OutgoingMail) {
    this.sends++;
    return { messageId: outgoing.messageId, sentCopy: true };
  }
  async findSent(): Promise<boolean> {
    return false;
  }
  async health(): Promise<void> {}
}

function mailbox() {
  const transport = new MailDouble();
  const registry = new ConnectorRegistry();
  registry.register(CONNECTION, new EmailConnector(config, secret, () => transport));
  return {
    transport,
    registry,
    reader: connectorMailbox({
      registry,
      connectionId: CONNECTION,
      spaceId: SPACE,
      undatedAt: UNDATED,
    }),
  };
}

describe('reading a mailbox through the installed connector', () => {
  test('reads the messages the connector returns, newest first', async () => {
    const { reader, transport } = mailbox();
    const read = await reader.recent(50);
    expect(transport.searches).toBe(1);
    expect(read.map((entry) => entry.messageId)).toEqual([
      '<4@nimbusledger.example>',
      '<3@nimbusledger.example>',
      '<1@nimbusledger.example>',
    ]);
  });

  test('never sends anything, whatever it is asked for', async () => {
    const { reader, transport } = mailbox();
    await reader.recent(50);
    expect(transport.sends).toBe(0);
  });

  test('inbox hygiene is the connector’s own, so a passcode never reaches the scan', async () => {
    const { reader } = mailbox();
    const read = await reader.recent(50);
    // The connector withheld it: the scan never had the chance to.
    expect(read.some((entry) => /OTP|passcode/i.test(entry.text))).toBe(false);
    expect(read.some((entry) => entry.messageId === '<2@nimbusledger.example>')).toBe(false);
  });

  test('a message nobody can cite is left out, because evidence needs a message id', async () => {
    const { reader } = mailbox();
    const read = await reader.recent(50);
    expect(read.some((entry) => entry.subject === 'Anonymous')).toBe(false);
  });

  test('a message the transport could not date is dated at the scan, not guessed at', async () => {
    const { reader } = mailbox();
    const read = await reader.recent(50);
    const undated = read.find((entry) => entry.messageId === '<4@nimbusledger.example>');
    expect(undated?.receivedAt).toBe(UNDATED);
  });

  test('the Date header becomes the received time the window is measured against', async () => {
    const { reader } = mailbox();
    const read = await reader.recent(50);
    const dated = read.find((entry) => entry.messageId === '<3@nimbusledger.example>');
    expect(dated?.receivedAt).toBe('2026-09-16T08:00:00.000Z');
    // And the window can now actually exclude something.
    const narrow = prefilter(read, { now: new Date(UNDATED), windowDays: 1 });
    const wide = prefilter(read, { now: new Date(UNDATED), windowDays: 90 });
    expect(narrow.counts.inWindow).toBeLessThan(wide.counts.inWindow);
  });

  test('never asks the connector for more than its search tool permits', async () => {
    const { reader, transport } = mailbox();
    await reader.recent(5000);
    expect(transport.lastLimit).toBe(50);
  });

  test('the HTML part is dropped, so only the text a quote can index into is kept', async () => {
    const { reader } = mailbox();
    const read = await reader.recent(50);
    for (const entry of read) expect(entry.text).not.toContain('<p>');
  });

  test('a connection this server has not opened is a mailbox it could not read', async () => {
    const reader = connectorMailbox({
      registry: new ConnectorRegistry(),
      connectionId: 'con_absent',
      spaceId: SPACE,
      undatedAt: UNDATED,
    });
    // An empty answer here would read to the person as an empty inbox.
    await expect(reader.recent(50)).rejects.toThrow(/^I couldn't read your mailbox: /);
  });

  test('a connection belonging to another space is refused by the connector itself', async () => {
    const { registry } = mailbox();
    const reader = connectorMailbox({
      registry,
      connectionId: CONNECTION,
      // The connector's own context check compares this against its configuration.
      spaceId: 'spc_somebody_else',
      undatedAt: UNDATED,
    });
    await expect(reader.recent(50)).rejects.toThrow(/^I couldn't read your mailbox: /);
  });

  test('a scan of a mailbox that cannot be read fails and says so', async () => {
    const { transport, reader } = mailbox();
    transport.search = async () => {
      throw new Error('IMAP login failed for accounts@thackeraylane.example');
    };
    const store = new MemoryCompanyStore();
    const owner = { spaceId: SPACE, principalId: 'own_01J0000000000000000000000B' };
    const outcome = await runScan({
      store,
      mailbox: reader,
      extractor: scriptedExtractor(),
      owner,
      now: new Date(UNDATED),
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/^I couldn't read your mailbox: /);
    // The reason is the product's own words, never the transport's.
    expect(outcome.error).not.toContain('thackeraylane');
    expect((await store.scan(owner, outcome.id))?.status).toBe('failed');
  });

  test('the whole demonstration mailbox survives the round trip through a real connector', async () => {
    // The strongest statement this file can make without an IMAP server: the
    // forty fixture messages go in as the connector's own shape, come back
    // through EmailConnector.execute, and are still the messages the scan
    // expects — minus exactly the three hygiene withholds.
    const transport = new MailDouble();
    transport.messages = fixtureMailMessages();
    const registry = new ConnectorRegistry();
    registry.register(CONNECTION, new EmailConnector(config, secret, () => transport));
    const reader = connectorMailbox({
      registry,
      connectionId: CONNECTION,
      spaceId: SPACE,
      undatedAt: UNDATED,
    });
    const read = await reader.recent(50);
    expect(read).toHaveLength(FIXTURE_MESSAGE_COUNT - 3);
    expect(read.some((entry) => /OTP|magic link|reset your password/i.test(entry.text))).toBe(
      false,
    );
    // And every message kept its own date, so the window means something.
    const direct = new Map(fixtureMessages().map((entry) => [entry.messageId, entry]));
    for (const entry of read) {
      const original = direct.get(entry.messageId);
      expect(original).toBeDefined();
      if (!original) continue;
      expect(entry.receivedAt).toBe(original.receivedAt);
      expect(entry.text).toBe(original.text);
    }
  });

  test('a scan driven through the connector agrees with one driven from the fixture', async () => {
    // The live path and the test path must not be two different products. Read
    // the same mailbox both ways — once through EmailConnector.execute, once
    // straight from the fixture — and the maps must be the same map.
    const transport = new MailDouble();
    transport.messages = fixtureMailMessages();
    const registry = new ConnectorRegistry();
    registry.register(CONNECTION, new EmailConnector(config, secret, () => transport));
    const owner = { spaceId: SPACE, principalId: 'own_01J0000000000000000000000B' };
    const now = new Date(UNDATED);
    const shape = async (mailbox: Parameters<typeof runScan>[0]['mailbox']) => {
      const store = new MemoryCompanyStore();
      const outcome = await runScan({
        store,
        mailbox,
        extractor: scriptedExtractor(),
        owner,
        now,
      });
      const map = await store.map(owner, now);
      return {
        status: outcome.status,
        messagesSeen: outcome.messagesSeen,
        totals: map.totals,
        companies: map.companies.map((entry) => entry.domain).sort(),
        items: map.items
          .map((item) => `${item.kind}|${item.direction}|${item.amount_minor}|${item.currency}`)
          .sort(),
      };
    };
    const throughConnector = await shape(
      connectorMailbox({
        registry,
        connectionId: CONNECTION,
        spaceId: SPACE,
        undatedAt: UNDATED,
      }),
    );
    const fromFixture = await shape(fixtureMailbox(fixtureMessages()));
    expect(throughConnector.status).toBe('done');
    expect(throughConnector.items.length).toBeGreaterThan(20);

    // The map is the same map: same companies, same items, same totals.
    const { messagesSeen: throughSeen, ...throughRest } = throughConnector;
    const { messagesSeen: fixtureSeen, ...fixtureRest } = fromFixture;
    expect(throughRest).toEqual(fixtureRest);

    // `messages_seen` is the one figure that differs, and it should. Through the
    // connector, hygiene withholds three messages before the scan is handed
    // anything, so the scan never sees them to count. Read straight from the
    // fixture, the scan is handed all forty and withholds the three itself.
    // The figure means "messages this scan was given" on both paths.
    expect(fixtureSeen).toBe(FIXTURE_MESSAGE_COUNT);
    expect(throughSeen).toBe(FIXTURE_MESSAGE_COUNT - 3);
  });

  test('a connector that is not a mailbox is not read', async () => {
    const registry = new ConnectorRegistry();
    registry.register(CONNECTION, {
      manifest: {
        name: 'files',
        version: '0.1.0',
        provider: 'files',
        description: 'A connector that is not a mailbox.',
        credentials: [],
        health: false,
        tools: [
          {
            name: 'files.read',
            description: 'Read a recorded file.',
            input_schema: { type: 'object' },
            effect_class: 'read',
            required_scopes: ['files.read'],
            verify: false,
            requires_approval: false,
          },
        ],
      },
      async execute() {
        throw new Error('this connector must never be asked');
      },
      async verify() {
        return { decision: 'unsupported' as const, reason: 'x' };
      },
      async health() {
        return { status: 'ok' as const, detail: 'x', checked_at: UNDATED };
      },
    });
    const reader = connectorMailbox({
      registry,
      connectionId: CONNECTION,
      spaceId: SPACE,
      undatedAt: UNDATED,
    });
    await expect(reader.recent(50)).rejects.toThrow(/^I couldn't read your mailbox: /);
  });
});

test('a display name that spells out a known company’s address does not file mail under it', async () => {
  // The name decodes to `Nimbus Ledger" <billing@nimbusledger.example> "`; the
  // message is from someone else entirely.
  const name = Buffer.from('Nimbus Ledger" <billing@nimbusledger.example> "').toString('base64');
  const crafted = toMailMessage(
    9,
    await simpleParser(
      `From: =?UTF-8?B?${name}?= <x@evil.test>\r\nMessage-ID: <9@evil.test>\r\nDate: Tue, 15 Sep 2026 10:00:00 +0000\r\nSubject: Your invoice is overdue\r\n\r\nPay the overdue invoice now.`,
    ),
  );
  const transport = new MailDouble();
  transport.messages = [transport.messages[0] as MailMessage, crafted];
  const registry = new ConnectorRegistry();
  registry.register(CONNECTION, new EmailConnector(config, secret, () => transport));
  const read = await connectorMailbox({
    registry,
    connectionId: CONNECTION,
    spaceId: SPACE,
    undatedAt: UNDATED,
  }).recent(50);
  const grouped = prefilter(read, { now: new Date(UNDATED), windowDays: 90 });
  const nimbus = grouped.companies.find((group) => group.domain === 'nimbusledger.example');
  expect(nimbus?.candidates.map((message) => message.messageId)).toEqual([
    '<1@nimbusledger.example>',
  ]);
  expect(grouped.companies.find((group) => group.domain === 'evil.test')?.messageCount).toBe(1);
});

test('scanned mail with two From headers is filed under no company', async () => {
  const doubled = toMailMessage(
    9,
    await simpleParser(
      'From: x@evil.test\r\nFrom: billing@nimbusledger.example\r\nMessage-ID: <9@evil.test>\r\nDate: Tue, 15 Sep 2026 10:00:00 +0000\r\nSubject: Your invoice is overdue\r\n\r\nPay the overdue invoice now.',
    ),
  );
  const transport = new MailDouble();
  transport.messages = [doubled];
  const registry = new ConnectorRegistry();
  registry.register(CONNECTION, new EmailConnector(config, secret, () => transport));
  const read = await connectorMailbox({
    registry,
    connectionId: CONNECTION,
    spaceId: SPACE,
    undatedAt: UNDATED,
  }).recent(50);
  const grouped = prefilter(read, { now: new Date(UNDATED), windowDays: 90 });
  expect(grouped.companies).toEqual([]);
  expect(grouped.counts.noSender).toBe(1);
});
