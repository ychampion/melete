/**
 * What every command is given: where the deployment directory is, and the ways
 * it reaches the machine. Each is injected so a command is tested with a fake
 * Docker and a temporary directory.
 */
import { createHash } from 'node:crypto';
import { closeSync, openSync, statfsSync, statSync, writeSync } from 'node:fs';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import {
  type CommandOutput,
  spawnCommand,
} from '../../../apps/melete/src/runtime/docker-engine.ts';
import { localMachine, type MachineAccess } from '../../../apps/melete/src/runtime/docker-host.ts';

export type Run = (command: readonly string[], timeoutMs?: number) => CommandOutput;

/** Where a stream's bytes come from, or go: a file, or a command's stdout or stdin. */
export type Endpoint = { file: string } | { command: readonly string[] };
/** A stream's source may also be bytes already in hand, such as a checksum list. */
export type Source = Endpoint | { bytes: Uint8Array };

export type StreamResult = {
  /** The source and every sink finished without an error. */
  ok: boolean;
  bytes: number;
  /** sha256 of the bytes, hex. */
  sha256: string;
  /** Why it did not finish; stderr is cut short and never holds the bytes themselves. */
  detail: string;
};

/**
 * - `free`: nothing listens there;
 * - `in_use`: something accepted a connection;
 * - `no_address`: the address is not one of this machine's, so nothing can be published on it;
 * - `unknown`: no answer in time.
 */
export type PortProbe = 'free' | 'in_use' | 'no_address' | 'unknown';

export type Context = {
  /** The deployment directory: deploy/ in the checkout, or the one --deploy-dir names. */
  deployDir: string;
  /** The checkout the deployment directory belongs to. */
  root: string;
  /** Runs a command to completion and returns what it printed. */
  run: Run;
  /** Runs a command with this terminal attached, and returns its exit code. */
  attach: (command: readonly string[]) => Promise<number>;
  machine: MachineAccess;
  /** Whether something listens on an address and port of this machine. It never binds the port. */
  probePort: (host: string, port: number) => Promise<PortProbe>;
  /** Fetch, for the registry check `doctor` makes and the health check after a deploy. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /**
   * Copies bytes from a file or a command's output into every sink at once, hashing
   * them on the way. A file sink is created new and private (0600); one that exists
   * is refused. Nothing passes through a string, so a dump or an archive is binary-safe
   * and no secret is ever held as text.
   */
  stream: (source: Source, sinks: readonly Endpoint[]) => Promise<StreamResult>;
  /** Free bytes on the filesystem holding a path, or its nearest existing parent; null when unknown. */
  freeAt: (path: string) => number | null;
  /** Whether two paths are on one filesystem; null when either cannot be read. */
  sameDisk: (a: string, b: string) => boolean | null;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  out: (text: string) => void;
  err: (text: string) => void;
};

export const DEFAULT_DEPLOY_DIR = resolve(import.meta.dir, '../../../deploy');

async function attach(command: readonly string[]): Promise<number> {
  try {
    const child = Bun.spawn([...command], {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    return await child.exited;
  } catch {
    return 127;
  }
}

/** Addresses that mean every interface: probed through loopback, which a wildcard listener also covers. */
const WILDCARD = new Set(['', '0.0.0.0', '::']);

/** Whether `address` belongs to this machine, from its interfaces. */
function localAddress(address: string): boolean {
  if (address === 'localhost' || /^127(\.\d{1,3}){3}$/.test(address)) return true;
  return Object.values(networkInterfaces()).some((entries) =>
    (entries ?? []).some((entry) => entry.address === address),
  );
}

/**
 * Asks by connecting, so the probe has no effect on the port: a bind, even a
 * brief one, could make Compose's own bind fail if it started at that moment.
 * An address that is not this machine's is never connected to, so a listener
 * on another machine is not mistaken for one here.
 */
export async function probePort(host: string, port: number): Promise<PortProbe> {
  const target = WILDCARD.has(host) ? '127.0.0.1' : host;
  if (!localAddress(target)) return 'no_address';
  return await new Promise((settle) => {
    const socket = connect({ host: target, port });
    socket.setTimeout(1_500);
    const done = (probe: PortProbe) => {
      socket.destroy();
      settle(probe);
    };
    socket.once('connect', () => done('in_use'));
    socket.once('timeout', () => done('unknown'));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') done('free');
      else if (
        ['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'ENETUNREACH', 'EHOSTUNREACH'].includes(error.code ?? '')
      )
        done('no_address');
      else done('unknown');
    });
  });
}

function nearest(path: string): string {
  let current = resolve(path);
  for (;;) {
    try {
      statSync(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

function freeAt(path: string): number | null {
  try {
    const stats = statfsSync(nearest(path));
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

function sameDisk(a: string, b: string): boolean | null {
  try {
    return statSync(nearest(a)).dev === statSync(nearest(b)).dev;
  } catch {
    return null;
  }
}

const STREAM_TIMEOUT_MS = 6 * 60 * 60_000;

async function stream(source: Source, sinks: readonly Endpoint[]): Promise<StreamResult> {
  const hash = createHash('sha256');
  let bytes = 0;
  const problems: string[] = [];
  const files: number[] = [];
  const children: { name: string; child: ReturnType<typeof Bun.spawn> }[] = [];
  let producer: ReturnType<typeof Bun.spawn> | null = null;
  const short = (text: string) => text.trim().split('\n').slice(-3).join(' ').slice(0, 400);
  try {
    const writers: ((chunk: Uint8Array) => Promise<void>)[] = [];
    const closers: (() => Promise<void>)[] = [];
    for (const sink of sinks) {
      if ('file' in sink) {
        const fd = openSync(sink.file, 'wx', 0o600);
        files.push(fd);
        writers.push(async (chunk) => {
          let offset = 0;
          while (offset < chunk.length) offset += writeSync(fd, chunk, offset);
        });
      } else {
        const child = Bun.spawn([...sink.command], {
          stdin: 'pipe',
          stdout: 'ignore',
          stderr: 'pipe',
        });
        children.push({ name: sink.command[0] ?? 'command', child });
        const stdin = child.stdin as import('bun').FileSink;
        writers.push(async (chunk) => {
          stdin.write(chunk);
          await stdin.flush();
        });
        closers.push(async () => {
          await stdin.end();
        });
      }
    }
    let reader: ReadableStream<Uint8Array>;
    const producerName = 'command' in source ? (source.command[0] ?? 'command') : '';
    if ('bytes' in source) reader = new Blob([source.bytes]).stream();
    else if ('file' in source) reader = Bun.file(source.file).stream();
    else {
      producer = Bun.spawn([...source.command], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      reader = producer.stdout as ReadableStream<Uint8Array>;
    }
    const timer = setTimeout(() => {
      producer?.kill();
      for (const { child } of children) child.kill();
    }, STREAM_TIMEOUT_MS);
    try {
      for await (const chunk of reader) {
        hash.update(chunk);
        bytes += chunk.length;
        for (const write of writers) await write(chunk);
      }
      for (const close of closers) await close();
      if (producer) {
        const [code, stderr] = await Promise.all([
          producer.exited,
          new Response(producer.stderr as ReadableStream).text(),
        ]);
        if (code !== 0) problems.push(`${producerName} exited ${code}: ${short(stderr)}`);
      }
      for (const { name, child } of children) {
        const [code, stderr] = await Promise.all([
          child.exited,
          new Response(child.stderr as ReadableStream).text(),
        ]);
        if (code !== 0) problems.push(`${name} exited ${code}: ${short(stderr)}`);
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    producer?.kill();
    for (const { child } of children) child.kill();
  } finally {
    for (const fd of files) closeSync(fd);
  }
  return {
    ok: problems.length === 0,
    bytes,
    sha256: hash.digest('hex'),
    detail: problems.join('; '),
  };
}

export function realContext(deployDir: string = DEFAULT_DEPLOY_DIR): Context {
  const dir = resolve(deployDir);
  return {
    deployDir: dir,
    root: dirname(dir),
    run: (command, timeoutMs = 60_000) => spawnCommand(command, timeoutMs),
    attach,
    machine: localMachine,
    probePort,
    fetch: (url, init) => fetch(url, init),
    stream,
    freeAt,
    sameDisk,
    sleep: (ms) => Bun.sleep(ms),
    now: () => new Date(),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  };
}
