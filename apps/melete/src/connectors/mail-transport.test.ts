import { describe, expect, test } from 'bun:test';
import { type AddressInfo, createServer, type Socket } from 'node:net';
import { EmailConnector } from './email.ts';
import { mailAction, mailContext } from './mail-fixtures.ts';
import { type EmailConnection, ImapSmtpTransport } from './mail-transport.ts';
import type { SecretAccess } from './secrets.ts';

/** A tiny protocol destination: test commands are real sockets, with no mailbox outside this process. */
async function mailServers(options: { smtpRefusesLogin?: boolean } = {}) {
  const sockets = new Set<Socket>();
  const sent: string[] = [];
  const auth: string[] = [];
  let dropAck = false;
  const inbox = [
    'From: friend@example.test\r\nTo: owner@example.test\r\nMessage-ID: <normal@example.test>\r\nSubject: Dinner\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSee you Friday.',
    'From: account@example.test\r\nTo: owner@example.test\r\nMessage-ID: <sensitive@example.test>\r\nSubject: Account information\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
      Buffer.from('Your one-time passcode is 123456.').toString('base64'),
  ];
  const imap = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('* OK Local IMAP test double\r\n');
    let buffer = '';
    let mailbox = 'INBOX';
    socket.on('data', (data) => {
      buffer += data.toString();
      while (buffer.includes('\r\n')) {
        const at = buffer.indexOf('\r\n');
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const tag = line.split(' ')[0] ?? '';
        const command = line.slice(tag.length + 1);
        const upper = command.toUpperCase();
        if (upper === 'CAPABILITY') socket.write('* CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR\r\n');
        else if (upper.startsWith('AUTHENTICATE PLAIN '))
          auth.push(Buffer.from(command.split(' ')[2] ?? '', 'base64').toString());
        else if (upper.startsWith('LIST '))
          socket.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n');
        else if (upper.startsWith('SELECT ') || upper.startsWith('EXAMINE ')) {
          mailbox = /sent/i.test(command) ? 'Sent' : 'INBOX';
          const messages = mailbox === 'Sent' ? sent : inbox;
          socket.write(
            `* FLAGS (\\Seen)\r\n* ${messages.length} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 1] Valid\r\n* OK [UIDNEXT ${messages.length + 1}] Next\r\n`,
          );
        } else if (upper.startsWith('UID SEARCH')) {
          const messages = mailbox === 'Sent' ? sent : inbox;
          socket.write(
            `* SEARCH${messages.length ? ` ${messages.map((_, index) => index + 1).join(' ')}` : ''}\r\n`,
          );
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
                `* ${uid} FETCH (UID ${uid} RFC822.SIZE ${Buffer.byteLength(source)})\r\n`,
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
    auth,
    sent,
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

describe('IMAP and SMTP wire adapters', () => {
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
