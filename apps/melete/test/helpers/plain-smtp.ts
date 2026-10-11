/**
 * A mail server that offers no STARTTLS and keeps the lines of what it is sent.
 * It listens on 127.0.0.2, which Linux routes to this machine but a sender
 * treats as any other address, so the sender's own TLS rule is what a test
 * sees. Elsewhere there is no such address: `server` is null and tests skip.
 */
export const plainSmtpAvailable = process.platform === 'linux';

export function plainSmtpServer() {
  const received: string[] = [];
  const server = plainSmtpAvailable
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
  return {
    received,
    url: server ? `smtp://127.0.0.2:${server.port}` : '',
    stop: () => server?.stop(true),
  };
}
