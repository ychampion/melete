import { describe, expect, test } from 'bun:test';
import { type AddressInfo, createServer, type Socket } from 'node:net';
import { simpleParser } from 'mailparser';
import { pdfWith, TINY_PNG } from '../attachments/fixtures.ts';
import { EmailConnector } from './email.ts';
import { mailAction, mailContext } from './mail-fixtures.ts';
import {
  composeMail,
  type EmailConnection,
  ImapSmtpTransport,
  MAX_MIME_PARTS,
  mimePartCount,
  parseMailMessage,
  toMailMessage,
} from './mail-transport.ts';
import { UNREACHABLE } from './public-fetch.ts';
import type { SecretAccess } from './secrets.ts';
import type { ResolvedAddress } from './web.ts';

/**
 * The UIDs an IMAP SEARCH matches, for the keys these tests send: TEXT (a
 * substring of the whole message, in any case), OR, ALL and parenthesised
 * lists, with every key in a list required. Anything else is refused, as a
 * server refuses a search it cannot read.
 */
function matching(criteria: string, messages: string[]): number[] {
  const list = criteria.match(/"(?:\\.|[^"\\])*"|\(|\)|[^\s()]+/g) ?? [];
  return messages.flatMap((source, index) => {
    const text = source.toLowerCase();
    let at = 0;
    const value = () => {
      const raw = list[at++] ?? '';
      return raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, '$1') : raw;
    };
    const key = (): boolean => {
      const token = list[at++] ?? '';
      if (token === '(') {
        let all = true;
        while (at < list.length && list[at] !== ')') all = key() && all;
        at++;
        return all;
      }
      switch (token.toUpperCase()) {
        case 'ALL':
          return true;
        case 'OR': {
          const left = key();
          const right = key();
          return left || right;
        }
        case 'TEXT':
          return text.includes(value().toLowerCase());
        case 'HEADER': {
          const name = value().toLowerCase();
          const wanted = value().toLowerCase();
          const head = text.split('\r\n\r\n')[0] ?? '';
          return head
            .split('\r\n')
            .some((line) => line.startsWith(`${name}:`) && line.includes(wanted));
        }
        default:
          throw new Error(`unsupported search key ${token}`);
      }
    };
    let all = true;
    while (at < list.length) all = key() && all;
    return all ? [index + 1] : [];
  });
}

/** A tiny protocol destination: test commands are real sockets, with no mailbox outside this process. */
async function mailServers(
  options: {
    smtpRefusesLogin?: boolean;
    sentName?: string;
    inbox?: string[];
    reportedSize?: number;
    more?: string[];
  } = {},
) {
  const sentName = options.sentName ?? 'Sent';
  const sockets = new Set<Socket>();
  const sent: string[] = [];
  const auth: string[] = [];
  const commands: string[] = [];
  const searches: string[] = [];
  let dropAck = false;
  let connections = 0;
  const inbox = options.inbox ?? [
    'From: friend@example.test\r\nTo: owner@example.test\r\nMessage-ID: <normal@example.test>\r\nSubject: Dinner\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSee you Friday.',
    'From: account@example.test\r\nTo: owner@example.test\r\nMessage-ID: <sensitive@example.test>\r\nSubject: Account information\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
      Buffer.from('Your one-time passcode is 123456.').toString('base64'),
    ...(options.more ?? []),
  ];
  const imap = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('* OK Local IMAP test double\r\n');
    let buffer = '';
    let mailbox = 'INBOX';
    // A command can carry a string as a literal: its size, then the bytes once the server says go on.
    let pending = '';
    let asked = false;
    socket.on('data', (data) => {
      buffer += data.toString();
      for (;;) {
        const at = buffer.indexOf('\r\n');
        if (at < 0) break;
        const head = buffer.slice(0, at);
        const literal = /\{(\d+)(\+?)\}$/.exec(head);
        if (literal) {
          const size = Number(literal[1]);
          if (buffer.length < at + 2 + size) {
            if (!literal[2] && !asked) socket.write('+ go on\r\n');
            asked = true;
            break;
          }
          asked = false;
          const value = buffer
            .slice(at + 2, at + 2 + size)
            .replace(/["\\]/g, (char) => `\\${char}`);
          pending += `${head.slice(0, literal.index)}"${value}"`;
          buffer = buffer.slice(at + 2 + size);
          continue;
        }
        const line = pending + head;
        pending = '';
        buffer = buffer.slice(at + 2);
        const tag = line.split(' ')[0] ?? '';
        const command = line.slice(tag.length + 1);
        const upper = command.toUpperCase();
        commands.push(command);
        if (upper === 'CAPABILITY') socket.write('* CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR\r\n');
        else if (upper.startsWith('AUTHENTICATE PLAIN '))
          auth.push(Buffer.from(command.split(' ')[2] ?? '', 'base64').toString());
        else if (command === 'LIST "" ""') socket.write('* LIST (\\Noselect) "/" ""\r\n');
        else if (upper.startsWith('LIST '))
          socket.write(
            `* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\HasNoChildren \\Sent) "/" "${sentName}"\r\n`,
          );
        else if (upper.startsWith('SELECT ') || upper.startsWith('EXAMINE ')) {
          const name = command.slice(command.indexOf(' ') + 1).replace(/^"|"$/g, '');
          if (name !== 'INBOX' && name !== sentName) {
            socket.write(`${tag} NO [NONEXISTENT] No such mailbox\r\n`);
            continue;
          }
          mailbox = name === sentName ? 'Sent' : 'INBOX';
          const messages = mailbox === 'Sent' ? sent : inbox;
          socket.write(
            `* FLAGS (\\Seen)\r\n* ${messages.length} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 1] Valid\r\n* OK [UIDNEXT ${messages.length + 1}] Next\r\n`,
          );
        } else if (upper.startsWith('UID SEARCH')) {
          const messages = mailbox === 'Sent' ? sent : inbox;
          searches.push(command);
          let found: number[];
          try {
            found = matching(command.slice('UID SEARCH'.length), messages);
          } catch {
            socket.write(`${tag} BAD search not understood\r\n`);
            continue;
          }
          socket.write(`* SEARCH${found.length ? ` ${found.join(' ')}` : ''}\r\n`);
        } else if (upper.startsWith('UID FETCH')) {
          const uid = Number(command.split(' ')[2]);
          const source = (mailbox === 'Sent' ? sent : inbox)[uid - 1];
          if (source) {
            if (upper.includes('ENVELOPE')) {
              const messageId = /^message-id:\s*(.+)$/im.exec(source)?.[1]?.trim() ?? '';
              socket.write(
                `* ${uid} FETCH (UID ${uid} ENVELOPE (NIL "subject" NIL NIL NIL NIL NIL NIL NIL "${messageId}"))\r\n`,
              );
            } else if (upper.includes('BODY.PEEK'))
              socket.write(
                `* ${uid} FETCH (UID ${uid} BODY[] {${Buffer.byteLength(source)}}\r\n${source})\r\n`,
              );
            else
              socket.write(
                `* ${uid} FETCH (UID ${uid} RFC822.SIZE ${options.reportedSize ?? Buffer.byteLength(source)})\r\n`,
              );
          }
        } else if (upper === 'LOGOUT') {
          socket.end(`* BYE\r\n${tag} OK done\r\n`);
          continue;
        }
        socket.write(`${tag} OK done\r\n`);
      }
    });
  });
  const smtp = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('220 localhost ESMTP test\r\n');
    let buffer = '';
    let dataMode = false;
    socket.on('data', (data) => {
      buffer += data.toString();
      for (;;) {
        if (dataMode) {
          const at = buffer.indexOf('\r\n.\r\n');
          if (at < 0) return;
          sent.push(buffer.slice(0, at).replace(/^\.\./gm, '.'));
          buffer = buffer.slice(at + 5);
          dataMode = false;
          if (dropAck) {
            socket.destroy();
            return;
          }
          socket.write('250 accepted\r\n');
        } else {
          const at = buffer.indexOf('\r\n');
          if (at < 0) return;
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (/^EHLO /i.test(line)) socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
          else if (/^AUTH PLAIN /i.test(line)) {
            auth.push(Buffer.from(line.split(' ')[2] ?? '', 'base64').toString());
            socket.write(
              options.smtpRefusesLogin
                ? '535 5.7.8 Authentication failed\r\n'
                : '235 authenticated\r\n',
            );
          } else if (line === 'DATA') {
            dataMode = true;
            socket.write('354 Send message\r\n');
          } else if (line === 'QUIT') {
            socket.end('221 Bye\r\n');
            return;
          } else socket.write('250 OK\r\n');
        }
      }
    });
  });
  await Promise.all([
    new Promise<void>((resolve) => imap.listen(0, '127.0.0.1', resolve)),
    new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve)),
  ]);
  const config: EmailConnection = {
    id: 'con_test',
    spaceId: 'spc_test',
    secretRef: 'sec_private',
    username: 'owner@example.test',
    from: 'owner@example.test',
    imap: { host: '127.0.0.1', port: (imap.address() as AddressInfo).port, secure: false },
    smtp: { host: '127.0.0.1', port: (smtp.address() as AddressInfo).port, secure: false },
    allowInsecureLocalForTests: true,
  };
  return {
    config,
    connections: () => connections,
    auth,
    commands,
    sent,
    searches,
    dropAck: () => {
      dropAck = true;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => imap.close(() => resolve())),
        new Promise<void>((resolve) => smtp.close(() => resolve())),
      ]);
    },
  };
}

/** A multipart message with `count` tiny text parts and no attachments. */
function manyParts(count: number, boundary = 'b1'): Buffer {
  const parts = Array.from(
    { length: count },
    (_, index) => `--${boundary}\r\nContent-Type: text/plain\r\n\r\npart ${index}\r\n`,
  );
  return Buffer.from(
    `From: sender@example.test\r\nTo: owner@example.test\r\nSubject: Parts\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed;\r\n boundary="${boundary}"\r\n\r\n${parts.join('')}--${boundary}--\r\n`,
  );
}

describe('MIME part bound', () => {
  test('a message with too many tiny parts is refused from its raw bytes before parsing', async () => {
    const flood = manyParts(MAX_MIME_PARTS + 50);
    expect(mimePartCount(flood)).toBeGreaterThan(MAX_MIME_PARTS);
    // The parser alone would accept it: these parts are body text, not attachments.
    const parsed = await simpleParser(flood, { skipImageLinks: true });
    expect(parsed.attachments).toHaveLength(0);
    expect(await parseMailMessage(1, flood)).toBeNull();
    const fine = manyParts(20);
    expect(mimePartCount(fine)).toBe(21);
    expect((await parseMailMessage(1, fine))?.subject).toBe('Parts');
  });

  test('the part count stops early, ignores lines naming no declared boundary, and covers RFC 2231 boundaries', () => {
    expect(mimePartCount(manyParts(5_000), 10)).toBe(11);
    const dashes = Buffer.from(
      `Subject: Report\r\nContent-Type: multipart/mixed; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/plain\r\n\r\n${'----------\r\n'.repeat(300)}--b1--\r\n`,
    );
    expect(mimePartCount(dashes)).toBe(2);
    const pieces = Buffer.from(
      `Subject: Parts\r\nContent-Type: multipart/mixed; boundary*0="b"; boundary*1="1"\r\n\r\n${'--b1\r\n\r\nx\r\n'.repeat(MAX_MIME_PARTS + 5)}--b1--\r\n`,
    );
    expect(mimePartCount(pieces)).toBeGreaterThan(MAX_MIME_PARTS);
    expect(mimePartCount(Buffer.from('Subject: Plain\r\n\r\n--not a part\r\n'))).toBe(1);
  });
});

describe('IMAP and SMTP wire adapters', () => {
  test('an incomplete IMAP message is withheld even when its prefix parses as harmless mail', async () => {
    const prefix = 'From: sender@example.test\r\nSubject: Account\r\n\r\nA harmless prefix.';
    const destination = await mailServers({
      inbox: [prefix],
      reportedSize: Buffer.byteLength(prefix) + 100,
    });
    try {
      expect(
        await new ImapSmtpTransport(destination.config, 'test-app-password').read(1),
      ).toBeNull();
    } finally {
      await destination.close();
    }
  });

  test('IMAP search skips a message above the body cap without fetching it; read opens it whole', async () => {
    const pdf = Buffer.concat([
      Buffer.from(pdfWith(['Statement total 42.'])),
      Buffer.alloc(300_000, 32),
    ]);
    const raw = await composeMail('sender@example.test', {
      to: ['owner@example.test'],
      cc: [],
      bcc: [],
      subject: 'Statement',
      body: 'The statement is attached.',
      messageId: '<statement@example.test>',
      attachments: [
        { filename: 'picture.pdf', content: Buffer.from(TINY_PNG), contentType: 'application/pdf' },
        { filename: 'statement.png', content: pdf, contentType: 'image/png' },
      ],
    });
    const destination = await mailServers({ inbox: [raw.toString()] });
    try {
      const connector = new EmailConnector(destination.config, {
        withSecret: async (_id, _space, use) => use('test-app-password'),
      });
      const search = await connector.execute(mailAction('email.search', {}), mailContext());
      expect(search.outcome).toBe('succeeded');
      if (search.outcome !== 'succeeded') return;
      expect(search.receipt.detail.messages).toEqual([]);
      // Only its size was asked for; the body was never fetched.
      expect(destination.commands.some((command) => /BODY\.PEEK/i.test(command))).toBe(false);
      const result = await connector.execute(mailAction('email.read', { uid: 1 }), mailContext());
      expect(result.outcome).toBe('succeeded');
      if (result.outcome !== 'succeeded') return;
      expect(result.receipt.detail.message).toMatchObject({
        attachments: [
          { id: '1', media_type: 'image/png', size: TINY_PNG.length },
          { id: '2', media_type: 'application/pdf', size: pdf.length },
        ],
      });
      expect(JSON.stringify(result)).not.toContain('"content"');
      const read = await connector.execute(
        mailAction('email.read_attachment', { uid: 1, attachment_id: '2' }),
        mailContext(),
      );
      expect(read.outcome).toBe('succeeded');
      if (read.outcome === 'succeeded')
        expect(read.receipt.detail.text).toContain('Statement total 42.');
    } finally {
      await destination.close();
    }
  });

  test('real libraries authenticate, decode MIME for hygiene, send with stable Message-ID and verify Sent', async () => {
    const destination = await mailServers();
    try {
      const secrets: SecretAccess = {
        withSecret: async (_id, _space, use) => use('test-app-password'),
      };
      const connector = new EmailConnector(destination.config, secrets);
      const searched = await connector.execute(mailAction('email.search'), mailContext());
      if (searched.outcome !== 'succeeded')
        throw new Error(`Search failed: ${JSON.stringify(searched)}`);
      expect(searched.receipt.detail.messages).toHaveLength(1);
      expect(JSON.stringify(searched)).not.toContain('123456');
      const action = mailAction('email.send', {
        to: ['friend@example.test'],
        subject: 'Hello',
        body: 'See you soon.',
      });
      expect((await connector.execute(action, mailContext())).outcome).toBe('succeeded');
      expect(destination.sent).toHaveLength(1);
      expect(destination.sent[0]).toContain('Message-ID: <act_test@melete.local>');
      expect((await connector.verify(action, mailContext())).decision).toBe('succeeded');
      const absent = { ...action, id: 'act_absent', idempotency_key: 'act_absent' };
      expect((await connector.verify(absent, mailContext('act_absent'))).decision).toBe(
        'undecided',
      );
      expect(destination.auth.some((value) => value.includes('test-app-password'))).toBe(true);
      expect(destination.sent[0]).not.toContain('test-app-password');
      destination.dropAck();
      const uncertain = mailAction(
        'email.send',
        { to: ['friend@example.test'], subject: 'A second message', body: 'Different action.' },
        'act_second',
      );
      expect((await connector.execute(uncertain, mailContext('act_second'))).outcome).toBe(
        'unknown',
      );
      expect((await connector.verify(uncertain, mailContext('act_second'))).decision).toBe(
        'succeeded',
      );
      expect(destination.sent).toHaveLength(2);
    } finally {
      await destination.close();
    }
  }, 20_000);

  test('a search with OR and quoted phrases finds each alternative, in one IMAP OR', async () => {
    const letter = (subject: string, body: string) =>
      `From: school@example.test\r\nTo: owner@example.test\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
    const servers = await mailServers({
      more: [
        letter('Field trip on Friday', 'The class field trip leaves at nine.'),
        letter('Forms', 'Please sign the permission slip by Wednesday.'),
        letter('Piano', 'Lessons move to Thursday.'),
      ],
    });
    try {
      const transport = new ImapSmtpTransport(servers.config, 'test-app-password');
      const subjects = async (query: string) =>
        (await transport.search(query, 10)).map((message) => message.subject);
      // Newest first, as every search is.
      expect(await subjects('"field trip" OR "permission slip"')).toEqual([
        'Forms',
        'Field trip on Friday',
      ]);
      expect(servers.searches.at(-1)).toBe(
        'UID SEARCH OR TEXT "field trip" TEXT "permission slip"',
      );
      // Words need not sit together; each must appear.
      expect(await subjects('class Friday')).toEqual(['Field trip on Friday']);
      expect(await subjects('(trip OR slip) Wednesday')).toEqual(['Forms']);
      expect(await subjects('field trip or piano')).toEqual(['Piano', 'Field trip on Friday']);
      // Operators IMAP has no words for fall back to the plain terms around them.
      expect(await subjects('subject:"field trip" OR is:unread')).toEqual(['Field trip on Friday']);
      expect(await subjects('NOT piano')).toEqual(await subjects(''));
      expect(await subjects('"school picnic" OR "bake sale"')).toEqual([]);
    } finally {
      await servers.close();
    }
  });

  test('a test reaches both halves: sending must work as well as reading', async () => {
    const working = await mailServers();
    const refusing = await mailServers({ smtpRefusesLogin: true });
    try {
      await new ImapSmtpTransport(working.config, 'test-app-password').health();
      // Reading still works; only the outgoing server refuses the password.
      const transport = new ImapSmtpTransport(refusing.config, 'test-app-password');
      await transport.search('', 5);
      expect(
        await transport.health().then(
          () => 'passed',
          () => 'failed',
        ),
      ).toBe('failed');
      // A closed outgoing port is the same failure, found before anything is sent.
      const closed = new ImapSmtpTransport(
        { ...working.config, smtp: { ...working.config.smtp, port: 1 } },
        'test-app-password',
      );
      expect(
        await closed.health().then(
          () => 'passed',
          () => 'failed',
        ),
      ).toBe('failed');
      expect(working.sent).toEqual([]);
    } finally {
      await working.close();
      await refusing.close();
    }
  }, 30_000);

  test('a sent folder named its own way is found by its flag, so a send can be confirmed', async () => {
    const destination = await mailServers({ sentName: 'Sent Messages' });
    try {
      const secrets: SecretAccess = { withSecret: async (_id, _space, use) => use('app-password') };
      const connector = new EmailConnector(destination.config, secrets);
      const action = mailAction('email.send', {
        to: ['friend@example.test'],
        subject: 'Hello',
        body: 'See you soon.',
      });
      expect((await connector.execute(action, mailContext())).outcome).toBe('succeeded');
      expect((await connector.verify(action, mailContext())).decision).toBe('succeeded');
    } finally {
      await destination.close();
    }
  }, 30_000);

  test('a refused password is told apart from a server that cannot be reached', async () => {
    const refusing = await mailServers({ smtpRefusesLogin: true });
    const working = await mailServers();
    try {
      const secrets: SecretAccess = { withSecret: async (_id, _space, use) => use('app-password') };
      expect(await new EmailConnector(refusing.config, secrets).health()).toMatchObject({
        status: 'failing',
        reason: 'credential_refused',
      });
      const closed = await new EmailConnector(
        { ...working.config, smtp: { ...working.config.smtp, port: 1 } },
        secrets,
      ).health();
      expect(closed.status).toBe('failing');
      expect(closed.reason).toBeUndefined();
    } finally {
      await refusing.close();
      await working.close();
    }
  }, 30_000);

  test('plaintext test exceptions cannot target remote servers', () => {
    const config: EmailConnection = {
      id: 'con_test',
      spaceId: 'spc_test',
      secretRef: 'sec_private',
      username: 'owner@example.test',
      from: 'owner@example.test',
      imap: { host: 'imap.example.test', port: 143, secure: false },
      smtp: { host: 'smtp.example.test', port: 25, secure: false },
      allowInsecureLocalForTests: true,
    };
    expect(() => new ImapSmtpTransport(config, 'private')).toThrow('loopback');
  });

  test('a mailbox that will not upgrade is unusable, and no password reaches it', async () => {
    const destination = await mailServers();
    try {
      // The same plaintext endpoints without the fixture exception: STARTTLS is
      // demanded of IMAP and TLS of SMTP, and neither destination offers it.
      const transport = new ImapSmtpTransport(
        { ...destination.config, allowInsecureLocalForTests: false },
        'app-password-never-sent',
      );
      const outcome = async (work: Promise<unknown>) =>
        work.then(
          () => 'reached',
          () => 'refused',
        );
      expect(await outcome(transport.health())).toBe('refused');
      expect(
        await outcome(
          transport.send({
            to: ['friend@example.test'],
            cc: [],
            bcc: [],
            subject: 'Hello',
            body: 'See you soon.',
            messageId: '<act_plain@melete.local>',
          }),
        ),
      ).toBe('refused');
      expect(destination.auth).toEqual([]);
      expect(destination.sent).toEqual([]);
    } finally {
      await destination.close();
    }
  }, 60_000);
});

describe('what a parsed message says about its thread and its sender', () => {
  const lines = (...parts: string[]) => parts.map((part) => `${part}\r\n`).join('');
  const raw = (headers: string) =>
    simpleParser(
      `${headers}${lines(
        'From: Jo <jo@shop.example>',
        'To: Sam <sam@studio.example>, ops@studio.example',
        'Cc: kim@studio.example',
        'Subject: Re: Quote',
        'Message-ID: <b@shop.example>',
        '',
      )}Here it is.`,
    );

  test('the thread it answers and everyone it went to', async () => {
    const message = toMailMessage(
      1,
      await raw(
        lines(
          'In-Reply-To: <a@studio.example>',
          'References: <z@studio.example> <a@studio.example>',
        ),
      ),
    );
    expect(message.in_reply_to).toBe('<a@studio.example>');
    expect(message.references).toEqual(['<z@studio.example>', '<a@studio.example>']);
    expect(message.to_addresses).toEqual([
      'sam@studio.example',
      'ops@studio.example',
      'kim@studio.example',
    ]);
    expect(message.automated).toBe(false);
  });

  test('list, bulk and auto-submitted mail is automated; a person writing is not', async () => {
    for (const header of [
      'List-Unsubscribe: <mailto:out@shop.example>',
      'List-Id: <news.shop.example>',
      'Auto-Submitted: auto-replied',
      'Precedence: bulk',
    ])
      expect(toMailMessage(1, await raw(lines(header))).automated).toBe(true);
    expect(toMailMessage(1, await raw(lines('Auto-Submitted: no'))).automated).toBe(false);
  });
});

describe('a mailbox added in the app is held to its space’s reach', () => {
  const answers =
    (address: string, family: 4 | 6 = 4) =>
    async (): Promise<ResolvedAddress[]> => [{ address, family }];
  const outcome = (promise: Promise<unknown>) =>
    promise.then(
      () => 'passed',
      (error: { fault?: unknown }) => error.fault ?? error,
    );

  test('someone else’s mailbox on the server’s own network is refused before any connection', async () => {
    const servers = await mailServers();
    try {
      // By address, and by a name that answers with one.
      for (const config of [
        { ...servers.config, reach: 'public' as const },
        {
          ...servers.config,
          imap: { ...servers.config.imap, host: 'localhost' },
          smtp: { ...servers.config.smtp, host: 'localhost' },
          reach: 'public' as const,
        },
      ]) {
        const transport = new ImapSmtpTransport(config, 'test-app-password', answers('127.0.0.1'));
        expect(await outcome(transport.health())).toMatchObject({
          kind: 'unsupported_route',
          detail: UNREACHABLE,
          may_have_committed: false,
        });
        expect(
          await outcome(
            transport.send({
              to: ['friend@example.test'],
              cc: [],
              bcc: [],
              subject: 'Hi',
              body: 'x',
              messageId: '<act_reach@melete.local>',
            }),
          ),
        ).toMatchObject({ kind: 'unsupported_route', may_have_committed: false });
      }
      expect(servers.connections()).toBe(0);
      expect(servers.auth).toEqual([]);
    } finally {
      await servers.close();
    }
  }, 30_000);

  test('the installation owner’s mailbox on their own network connects to the address it checked', async () => {
    const servers = await mailServers();
    try {
      const named = {
        ...servers.config,
        imap: { ...servers.config.imap, host: 'localhost' },
        smtp: { ...servers.config.smtp, host: 'localhost' },
        reach: 'installation' as const,
      };
      await new ImapSmtpTransport(named, 'test-app-password', answers('127.0.0.1')).health();
      expect(servers.connections()).toBeGreaterThan(0);
      // The same name answering with cloud metadata reaches nothing.
      const before = servers.connections();
      expect(
        await outcome(
          new ImapSmtpTransport(named, 'test-app-password', answers('169.254.169.254')).health(),
        ),
      ).toMatchObject({ kind: 'unsupported_route', detail: UNREACHABLE });
      expect(servers.connections()).toBe(before);
    } finally {
      await servers.close();
    }
  }, 30_000);
});
