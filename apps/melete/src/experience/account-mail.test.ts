import { afterAll, expect, test } from 'bun:test';
import { signInMail, smtpAccountMailer, smtpTransportOptions } from './account-mail.ts';

test('a mail server elsewhere must upgrade to TLS; one on this machine need not', () => {
  expect(smtpTransportOptions('smtp://user:pw@smtp.example.com:587').requireTLS).toBe(true);
  expect(smtpTransportOptions('smtp://10.0.0.5:25').requireTLS).toBe(true);
  expect(smtpTransportOptions('smtp://127.0.0.1:25').requireTLS).toBe(false);
  expect(smtpTransportOptions('smtp://localhost:25').requireTLS).toBe(false);
  expect(smtpTransportOptions('smtp://[::1]:25').requireTLS).toBe(false);
  expect(smtpTransportOptions('not a url').requireTLS).toBe(true);
  const options = smtpTransportOptions('smtps://user:pw@smtp.example.com:465');
  expect(options.url).toBe('smtps://user:pw@smtp.example.com:465');
  expect(options.connectionTimeout).toBe(10_000);
});

/**
 * A server that offers no STARTTLS and keeps what it is sent. It listens on
 * 127.0.0.2, which Linux routes to this machine but the sender treats as any
 * other address, so the sender's own TLS rule is what is tested.
 */
const linux = process.platform === 'linux';
const received: string[] = [];
const server = linux
  ? Bun.listen<{ data: boolean; buffer: string }>({
      hostname: '127.0.0.2',
      port: 0,
      socket: {
        open(socket) {
          socket.data = { data: false, buffer: '' };
          socket.write('220 test ESMTP\r\n');
        },
        data(socket, chunk) {
          socket.data.buffer += chunk.toString();
          for (let end = socket.data.buffer.indexOf('\r\n'); end >= 0; ) {
            const line = socket.data.buffer.slice(0, end);
            socket.data.buffer = socket.data.buffer.slice(end + 2);
            end = socket.data.buffer.indexOf('\r\n');
            if (socket.data.data) {
              if (line === '.') {
                socket.data.data = false;
                socket.write('250 kept\r\n');
              } else received.push(line);
              continue;
            }
            const verb = line.slice(0, 4).toUpperCase();
            if (verb === 'EHLO') socket.write('250 test\r\n');
            else if (line.toUpperCase() === 'STARTTLS') socket.write('502 not offered\r\n');
            else if (verb === 'DATA') {
              socket.data.data = true;
              socket.write('354 go on\r\n');
            } else if (verb === 'QUIT') {
              socket.write('221 bye\r\n');
              socket.end();
            } else socket.write('250 ok\r\n');
          }
        },
      },
    })
  : null;
afterAll(() => server?.stop(true));

test.skipIf(!linux)(
  'a link is never sent to a server that cannot take TLS, unless its URL allows that',
  async () => {
    const at = `smtp://127.0.0.2:${server?.port}`;
    const from = 'Melete <melete@example.test>';
    const mail = signInMail('person@example.test', 'https://melete.example.test/#/welcome?token=x');
    await expect(smtpAccountMailer({ smtpUrl: at, from }).send(mail)).rejects.toThrow(/TLS/);
    expect(received).toEqual([]);
    await smtpAccountMailer({ smtpUrl: `${at}?requireTLS=false`, from }).send(mail);
    expect(received).toContain('Subject: Melete sign-in link');
  },
);
