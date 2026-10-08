/**
 * A small MCP stdio client for the Cua Driver executable (`cua-driver mcp`).
 *
 * Spike only. The driver owns its runtime for the life of this one connection,
 * so the session-scoped browser targets, tabs and refs it mints stay valid
 * between calls. Nothing here opens a socket: the driver is a child process on
 * pipes, the same shape as the service's stdio MCP connectors.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

export type CuaDriverCall = {
  readonly tool: string;
  readonly ok: boolean;
  readonly ms: number;
  /** `structuredContent` when the driver sends it, else the parsed text content. */
  readonly result: unknown;
  readonly text: string;
};

export type CuaDriverOptions = {
  /** Absolute path of `cua-driver` (or `cua-driver.exe`). */
  readonly binary: string;
  /** The child's whole environment; nothing of the caller's is inherited unless passed. */
  readonly env: Readonly<Record<string, string>>;
  readonly args?: readonly string[];
};

export class CuaDriverMcp {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = '';
  private readonly waiting = new Map<number, (message: Record<string, unknown>) => void>();
  readonly calls: CuaDriverCall[] = [];
  stderr = '';

  constructor(private readonly options: CuaDriverOptions) {}

  async start(): Promise<void> {
    const child = spawn(this.options.binary, ['mcp', ...(this.options.args ?? [])], {
      env: { ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf('\n');
      while (index >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        index = this.buffer.indexOf('\n');
        if (!line) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const id = message.id;
        if (typeof id === 'number' && this.waiting.has(id)) {
          this.waiting.get(id)?.(message);
          this.waiting.delete(id);
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-20_000);
    });
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'melete-spike', version: '0.0.0' },
    });
    this.notify('notifications/initialized', {});
  }

  private notify(method: string, params: unknown) {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private request(method: string, params: unknown, timeoutMs = 60_000) {
    const child = this.child;
    if (!child) throw new Error('cua-driver is not running');
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`cua-driver ${method} timed out`));
      }, timeoutMs);
      this.waiting.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve((message.result ?? {}) as Record<string, unknown>);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async listTools(): Promise<string[]> {
    const result = await this.request('tools/list', {});
    return ((result.tools ?? []) as { name: string }[]).map((tool) => tool.name);
  }

  /** One tool call. Never throws for a tool-level refusal: `ok` is false and `text` says why. */
  async call(tool: string, args: Record<string, unknown>, timeoutMs = 60_000) {
    const started = performance.now();
    const raw = await this.request('tools/call', { name: tool, arguments: args }, timeoutMs);
    const content = (raw.content ?? []) as { type: string; text?: string }[];
    const text = content
      .filter((item) => item.type === 'text')
      .map((item) => item.text ?? '')
      .join('\n');
    let parsed: unknown = raw.structuredContent;
    if (parsed === undefined) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    const call: CuaDriverCall = {
      tool,
      ok: raw.isError !== true,
      ms: Math.round(performance.now() - started),
      result: parsed,
      text,
    };
    this.calls.push(call);
    return call;
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
