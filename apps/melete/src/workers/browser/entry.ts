import { startBrowserServer } from './server.ts';
import { BrowserSessions } from './sessions.ts';

const sessions = new BrowserSessions({
  spaceId: process.env.MELETE_BROWSER_SPACE ?? '',
  spaceRoot: process.env.MELETE_BROWSER_ROOT ?? '',
  idleMs: Number(process.env.MELETE_BROWSER_IDLE_MS ?? 300_000),
});
const server = await startBrowserServer({
  sessions,
  token: process.env.MELETE_BROWSER_TOKEN ?? '',
  port: Number(process.env.MELETE_BROWSER_PORT ?? 0),
  hostname: process.env.MELETE_BROWSER_HOST ?? '127.0.0.1',
});
process.stdout.write(`${JSON.stringify({ port: server.port })}\n`);
const close = async () => {
  await server.stop(true);
  await sessions.close();
  process.exit(0);
};
process.once('SIGTERM', () => {
  void close();
});
process.once('SIGINT', () => {
  void close();
});
