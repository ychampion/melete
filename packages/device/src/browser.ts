/**
 * The bridge between Melete and the person's own browser.
 *
 * The Melete browser extension, once the person switches it on, asks the
 * browser to start this bridge through native messaging: the browser runs
 * `melete-device browser-host` and talks to it over its standard input and
 * output. Nothing listens on a port. The bridge holds its own outbound long
 * poll to Melete on the `browser` channel, hands each request to the
 * extension, and posts the extension's answer back.
 *
 * The bridge adds its own checks before anything reaches the browser: the
 * browser capability must be on in this computer's settings, and only the
 * browser tools pass. The extension checks the rest (which tabs are Melete's,
 * which fields are protected) where the page is.
 *
 * The extension never reads cookies and has no permission to; sign-in stays
 * in the browser, and nothing here sends it anywhere.
 */
import { appendFile, chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { ApiError, VERSION } from './agent.ts';
import { configDir, type DeviceConfig, logPath } from './config.ts';

/** The native messaging host's name, as the extension and the host manifest say it. */
export const HOST_NAME = 'com.melete.device';
/**
 * The extension's id, fixed by the public key in extension/manifest.json, so
 * an unpacked copy loaded from any folder has the same id.
 */
export const EXTENSION_ID = 'dgmacfdbibkgojajliiikiodbddflecn';

export const BROWSER_TOOLS = [
  'browser_open',
  'browser_read',
  'browser_click',
  'browser_type',
  'browser_screenshot',
] as const;

/* ---------- native messaging framing ---------- */

/** One message as the browser expects it: a 32-bit length in native byte order, then JSON. */
export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.byteLength, 0);
  return Buffer.concat([head, body]);
}

/** The browser caps messages to the host at 4 GB and from it at 1 MB; this reader takes 64 MB. */
const MAX_INBOUND = 64 * 1024 * 1024;

/** Splits a byte stream from the browser into messages. */
export class MessageReader {
  private buffer = Buffer.alloc(0);
  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    while (this.buffer.byteLength >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_INBOUND) throw new Error('a message from the browser is too large');
      if (this.buffer.byteLength < 4 + length) break;
      messages.push(JSON.parse(this.buffer.subarray(4, 4 + length).toString('utf8')));
      this.buffer = this.buffer.subarray(4 + length);
    }
    return messages;
  }
}

/* ---------- the bridge ---------- */

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

type Request = { id: string; tool: string; arguments: Record<string, unknown>; deadline: number };
type Answer =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string } };

export type BridgeOptions = {
  config: DeviceConfig;
  /** Sends one message to the extension. */
  send: (message: unknown) => void;
  fetch?: Fetch;
  configDir?: string;
  pollTimeoutMs?: number;
  print?: (line: string) => void;
};

export class BrowserBridge {
  private stopped = false;
  private readonly controller = new AbortController();
  private readonly waiting = new Map<string, (answer: Answer) => void>();
  private readonly fetcher: Fetch;

  constructor(private readonly options: BridgeOptions) {
    this.fetcher = options.fetch ?? fetch;
  }

  private async log(line: string) {
    const stamped = `${new Date().toISOString()}  [browser] ${line}`;
    this.options.print?.(stamped);
    await appendFile(logPath(this.options.configDir), `${stamped}\n`, { mode: 0o600 }).catch(
      () => {},
    );
  }

  private async call(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${this.options.config.token}`);
    if (init.body) headers.set('content-type', 'application/json');
    const response = await this.fetcher(`${this.options.config.api}${path}`, {
      ...init,
      headers,
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok)
      throw new ApiError(
        response.status,
        String((body?.error as { message?: unknown } | undefined)?.message ?? response.status),
      );
    return body;
  }

  /** A message from the extension. */
  receive(message: unknown) {
    const value = message as { type?: unknown; id?: unknown; answer?: unknown } | null;
    if (value?.type === 'answer' && typeof value.id === 'string') {
      const settle = this.waiting.get(value.id);
      if (settle) {
        this.waiting.delete(value.id);
        settle(value.answer as Answer);
      }
    }
    if (value?.type === 'stop') this.stop();
  }

  private ask(request: Request): Promise<Answer> {
    return new Promise((resolve) => {
      const left = Math.max(1_000, request.deadline - Date.now());
      const timer = setTimeout(() => {
        this.waiting.delete(request.id);
        resolve({ ok: false, error: { code: 'failed', message: 'The browser did not answer.' } });
      }, left);
      this.waiting.set(request.id, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
      this.options.send({ type: 'request', ...request });
    });
  }

  private async handle(request: Request) {
    let answer: Answer;
    if (!this.options.config.capabilities.browser)
      answer = {
        ok: false,
        error: {
          code: 'capability_off',
          message: 'Using the browser is turned off on this computer.',
        },
      };
    else if (!(BROWSER_TOOLS as readonly string[]).includes(request.tool))
      answer = {
        ok: false,
        error: { code: 'invalid_request', message: `Unknown request: ${request.tool}` },
      };
    else {
      await this.log(
        `→ ${request.tool}${typeof request.arguments.url === 'string' ? ` ${request.arguments.url}` : ''}`,
      );
      answer = await this.ask(request);
      await this.log(
        answer.ok ? `✓ ${request.tool}` : `✗ ${request.tool}: ${answer.error.message}`,
      );
    }
    await this.call(`/device/requests/${encodeURIComponent(request.id)}/result`, {
      method: 'POST',
      body: JSON.stringify(
        answer.ok
          ? { ok: true, result: answer.result }
          : {
              ok: false,
              error: { code: answer.error.code, message: answer.error.message.slice(0, 500) },
            },
      ),
    }).catch((error) => this.log(`Could not send the answer: ${(error as Error).message}`));
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.controller.abort();
  }

  /** Poll until stopped. Resolves `revoked` when Melete no longer accepts this computer. */
  async run(): Promise<'stopped' | 'revoked' | 'off'> {
    if (!this.options.config.capabilities.browser) {
      this.options.send({ type: 'status', state: 'off', device: this.options.config.name });
      await this.log(
        'The extension asked to connect, but using the browser is off on this computer.',
      );
      return 'off';
    }
    this.options.send({
      type: 'status',
      state: 'connected',
      device: this.options.config.name,
      version: VERSION,
    });
    await this.log('The browser extension is connected.');
    let backoff = 1_000;
    while (!this.stopped) {
      try {
        const signal = AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(this.options.pollTimeoutMs ?? 40_000),
        ]);
        const body = (await this.call('/device/requests?channel=browser', { signal })) as {
          requests: Request[];
        };
        backoff = 1_000;
        for (const request of body.requests) void this.handle(request);
      } catch (error) {
        if (this.stopped) break;
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          this.options.send({ type: 'status', state: error.status === 401 ? 'revoked' : 'off' });
          await this.log(`Melete refused the browser: ${error.message}`);
          return error.status === 401 ? 'revoked' : 'off';
        }
        if ((error as Error).name === 'TimeoutError') continue;
        this.options.send({ type: 'status', state: 'reconnecting' });
        await new Promise((resolve) => setTimeout(resolve, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
    await this.call('/device/browser/leave', { method: 'POST', body: '{}' }).catch(() => {});
    await this.log('The browser extension disconnected.');
    return 'stopped';
  }
}

/* ---------- installing the host ---------- */

type Browser = { name: string; windowsKey: string; macDir: string; linuxDir: string };

const BROWSERS: Browser[] = [
  {
    name: 'Chrome',
    windowsKey: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
    macDir: 'Library/Application Support/Google/Chrome/NativeMessagingHosts',
    linuxDir: '.config/google-chrome/NativeMessagingHosts',
  },
  {
    name: 'Chromium',
    windowsKey: 'HKCU\\Software\\Chromium\\NativeMessagingHosts',
    macDir: 'Library/Application Support/Chromium/NativeMessagingHosts',
    linuxDir: '.config/chromium/NativeMessagingHosts',
  },
  {
    name: 'Edge',
    windowsKey: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
    macDir: 'Library/Application Support/Microsoft Edge/NativeMessagingHosts',
    linuxDir: '.config/microsoft-edge/NativeMessagingHosts',
  },
  {
    name: 'Brave',
    windowsKey: 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
    macDir: 'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts',
    linuxDir: '.config/BraveSoftware/Brave-Browser/NativeMessagingHosts',
  },
];

/** The host manifest: which program the browser may start, and which extension may ask. */
export function hostManifest(launcher: string, extensionId = EXTENSION_ID) {
  return {
    name: HOST_NAME,
    description: 'Melete: lets the Melete extension reach this computer’s companion.',
    path: launcher,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

/**
 * Register the bridge with the browsers on this computer, for this user only.
 * Returns what was written, so the person can see it.
 */
export async function installHost(
  options: {
    extensionId?: string;
    dir?: string;
    run?: (command: string, args: string[]) => Promise<void>;
  } = {},
): Promise<string[]> {
  const dir = options.dir ?? configDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const cli = resolve(import.meta.dir, 'cli.ts');
  const bun = process.execPath;
  const configEnv = process.env.MELETE_DEVICE_CONFIG_DIR;
  const written: string[] = [];
  let launcher: string;
  if (platform() === 'win32') {
    launcher = join(dir, 'browser-host.cmd');
    await writeFile(
      launcher,
      [
        '@echo off',
        ...(configEnv ? [`set "MELETE_DEVICE_CONFIG_DIR=${configEnv}"`] : []),
        `"${bun}" "${cli}" browser-host %*`,
        '',
      ].join('\r\n'),
    );
  } else {
    launcher = join(dir, 'browser-host.sh');
    await writeFile(
      launcher,
      [
        '#!/bin/sh',
        ...(configEnv
          ? [`export MELETE_DEVICE_CONFIG_DIR='${configEnv.replaceAll("'", "'\\''")}'`]
          : []),
        `exec '${bun.replaceAll("'", "'\\''")}' '${cli.replaceAll("'", "'\\''")}' browser-host "$@"`,
        '',
      ].join('\n'),
      { mode: 0o700 },
    );
    await chmod(launcher, 0o700);
  }
  written.push(launcher);
  const manifest = `${JSON.stringify(hostManifest(launcher, options.extensionId), null, 2)}\n`;
  if (platform() === 'win32') {
    const file = join(dir, `${HOST_NAME}.json`);
    await writeFile(file, manifest);
    written.push(file);
    const run = options.run ?? runQuietly;
    for (const browser of BROWSERS) {
      await run('reg', [
        'add',
        `${browser.windowsKey}\\${HOST_NAME}`,
        '/ve',
        '/t',
        'REG_SZ',
        '/d',
        file,
        '/f',
      ]);
      written.push(`${browser.windowsKey}\\${HOST_NAME}`);
    }
  } else {
    for (const browser of BROWSERS) {
      const folder = join(homedir(), platform() === 'darwin' ? browser.macDir : browser.linuxDir);
      await mkdir(folder, { recursive: true });
      const file = join(folder, `${HOST_NAME}.json`);
      await writeFile(file, manifest);
      written.push(file);
    }
  }
  return written;
}

async function runQuietly(command: string, args: string[]) {
  const child = Bun.spawn([command, ...args], { stdout: 'ignore', stderr: 'pipe' });
  if ((await child.exited) !== 0)
    throw new Error(`${command} failed: ${(await new Response(child.stderr).text()).trim()}`);
}

/** Run as the browser's native messaging host: stdin and stdout belong to the browser. */
export async function hostMain(config: DeviceConfig | null): Promise<void> {
  const send = (message: unknown) => {
    process.stdout.write(encodeMessage(message));
  };
  if (!config) {
    send({ type: 'status', state: 'unpaired' });
    return;
  }
  const bridge = new BrowserBridge({ config, send });
  const reader = new MessageReader();
  process.stdin.on('data', (chunk: Buffer) => {
    try {
      for (const message of reader.push(chunk)) bridge.receive(message);
    } catch {
      bridge.stop();
    }
  });
  // The browser closes standard input when the extension disconnects.
  process.stdin.on('end', () => bridge.stop());
  process.stdin.on('close', () => bridge.stop());
  await bridge.run();
  process.exit(0);
}
