import { BrowserController } from './controller.ts';
import type { BrowserNetworkOptions } from './egress.ts';
import { startBrowserServer } from './server.ts';

export async function startBrowserWorker(options: { network?: BrowserNetworkOptions } = {}) {
  const controller = new BrowserController({
    spaceId: process.env.MELETE_BROWSER_SPACE ?? '',
    spaceRoot: process.env.MELETE_BROWSER_ROOT ?? '',
    idleMs: Number(process.env.MELETE_BROWSER_IDLE_MS ?? 300_000),
    headless: process.env.MELETE_BROWSER_HEADLESS !== 'false',
    network: options.network,
  });
  const { sessions } = controller;
  const server = await startBrowserServer({
    sessions,
    token: process.env.MELETE_BROWSER_TOKEN ?? '',
    port: Number(process.env.MELETE_BROWSER_PORT ?? 0),
    hostname: process.env.MELETE_BROWSER_HOST ?? '127.0.0.1',
    command: (input) => controller.command(input),
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
  return { controller, server, close };
}

if (import.meta.main) await startBrowserWorker();
