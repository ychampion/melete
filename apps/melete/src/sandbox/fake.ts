/**
 * An in-memory sandbox provider for the conformance suite.
 *
 * It is a fake that can fail. Commands run through a small interpreter for the
 * part of POSIX `sh` the service's own marker wrapper and the conformance
 * commands use, so the wrapper that runs here is the text a real sandbox runs.
 * Files live in a tree with directories, modes and symbolic links. Each sandbox
 * enforces the egress policy it was created with when a command resolves a
 * name or opens a connection, and a policy outside the declared capabilities is
 * refused at creation. A killed command stops where it is, so a marker it had
 * not finished writing stays unfinished.
 *
 * What it does not model is said here: there is one user, no resource limits,
 * no pipes, no background jobs, and the network answers without leaving the
 * process. A command it does not know exits 127, the way a shell would.
 */
import { isIP } from 'node:net';
import { LABEL_SESSION, ownedLabels } from './manifest.ts';
import { markerDirectory, reattachByMarker } from './marker.ts';
import {
  type EgressPolicy,
  type ExecOutcome,
  type ExecSpec,
  type FileEntry,
  type SandboxCapabilities,
  SandboxFileNotFound,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxSpec,
  SandboxTransportError,
} from './types.ts';

const EMPTY = new Uint8Array(0);
const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

export const FAKE_CAPABILITIES: SandboxCapabilities = {
  adapter: 'fake',
  isolation: 'unknown',
  egress: ['deny_all', 'domain_allowlist', 'cidr_allowlist', 'open'],
  persistence: ['none', 'pause'],
  maxLifetimeSeconds: 3_600,
  maxIdleSeconds: null,
  streaming: false,
  reattach: 'marker_only',
  ports: 'none',
  image: 'template',
  billing: 'per_second',
  regions: [],
  maxUploadBytes: 8 * 1024 * 1024,
};

// ---------------------------------------------------------------------------
// Filesystem

type FsNode =
  | { kind: 'file'; bytes: Uint8Array; mode: number }
  | { kind: 'dir'; mode: number }
  | { kind: 'symlink'; target: string };

export class FsError extends Error {
  constructor(
    readonly code: 'ENOENT' | 'EEXIST' | 'ENOTDIR' | 'EISDIR' | 'ELOOP' | 'EINVAL',
    readonly path: string,
  ) {
    super(`${code}: ${path}`);
  }
}

export class FakeFs {
  private readonly nodes = new Map<string, FsNode>();

  constructor() {
    this.nodes.set('/', { kind: 'dir', mode: 0o755 });
    for (const dir of ['/etc', '/home', '/home/user', '/tmp', '/var', '/var/tmp'])
      this.nodes.set(dir, { kind: 'dir', mode: dir.endsWith('tmp') ? 0o1777 : 0o755 });
    this.nodes.set('/etc/passwd', {
      kind: 'file',
      bytes: encode('root:x:0:0:root:/root:/bin/sh\nuser:x:1000:1000::/home/user:/bin/sh\n'),
      mode: 0o644,
    });
  }

  static normalize(value: string): string {
    const out: string[] = [];
    for (const part of value.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') out.pop();
      else out.push(part);
    }
    return `/${out.join('/')}`;
  }

  absolute(cwd: string, value: string): string {
    return FakeFs.normalize(value.startsWith('/') ? value : `${cwd}/${value}`);
  }

  /** Follow links in every parent, and in the last component when asked. */
  resolve(value: string, followLast: boolean, hops = 0): string {
    if (hops > 40) throw new FsError('ELOOP', value);
    const parts = FakeFs.normalize(value).split('/').filter(Boolean);
    let current = '/';
    for (let index = 0; index < parts.length; index += 1) {
      const candidate = current === '/' ? `/${parts[index]}` : `${current}/${parts[index]}`;
      const node = this.nodes.get(candidate);
      const last = index === parts.length - 1;
      if (node?.kind === 'symlink' && (!last || followLast)) {
        const target = node.target.startsWith('/') ? node.target : `${current}/${node.target}`;
        current = this.resolve(target, true, hops + 1);
        continue;
      }
      if (!last && node && node.kind !== 'dir') throw new FsError('ENOTDIR', candidate);
      if (!last && !node) throw new FsError('ENOENT', candidate);
      current = candidate;
    }
    return current;
  }

  /** Undefined when the path, or any directory on the way to it, is absent. */
  lstat(value: string): FsNode | undefined {
    try {
      return this.nodes.get(this.resolve(value, false));
    } catch (error) {
      if (error instanceof FsError) return undefined;
      throw error;
    }
  }

  stat(value: string): FsNode | undefined {
    try {
      return this.nodes.get(this.resolve(value, true));
    } catch (error) {
      if (error instanceof FsError) return undefined;
      throw error;
    }
  }

  private parentOf(target: string): string {
    const parent = target.slice(0, target.lastIndexOf('/')) || '/';
    const node = this.nodes.get(parent);
    if (!node) throw new FsError('ENOENT', parent);
    if (node.kind !== 'dir') throw new FsError('ENOTDIR', parent);
    return parent;
  }

  mkdir(value: string, parents: boolean, mode = 0o755): void {
    if (!parents) {
      const target = this.resolve(value, false);
      if (this.nodes.has(target)) throw new FsError('EEXIST', target);
      this.parentOf(target);
      this.nodes.set(target, { kind: 'dir', mode });
      return;
    }
    let prefix = '';
    for (const part of FakeFs.normalize(value).split('/').filter(Boolean)) {
      prefix += `/${part}`;
      const target = this.resolve(prefix, true);
      const existing = this.nodes.get(target);
      if (existing?.kind === 'dir') continue;
      if (existing) throw new FsError('EEXIST', target);
      this.parentOf(target);
      this.nodes.set(target, { kind: 'dir', mode });
    }
  }

  writeFile(
    value: string,
    bytes: Uint8Array,
    options: { append?: boolean; mode?: number; parents?: boolean } = {},
  ): void {
    if (options.parents) {
      const normalized = FakeFs.normalize(value);
      this.mkdir(normalized.slice(0, normalized.lastIndexOf('/')) || '/', true);
    }
    const target = this.resolve(value, true);
    this.parentOf(target);
    const existing = this.nodes.get(target);
    if (existing?.kind === 'dir') throw new FsError('EISDIR', target);
    const previous = existing?.kind === 'file' && options.append ? existing.bytes : EMPTY;
    const next = new Uint8Array(previous.byteLength + bytes.byteLength);
    next.set(previous);
    next.set(bytes, previous.byteLength);
    this.nodes.set(target, {
      kind: 'file',
      bytes: next,
      mode: options.mode ?? (existing?.kind === 'file' ? existing.mode : 0o644),
    });
  }

  readFile(value: string): Uint8Array {
    const target = this.resolve(value, true);
    const node = this.nodes.get(target);
    if (!node) throw new FsError('ENOENT', target);
    if (node.kind !== 'file') throw new FsError('EISDIR', target);
    return node.bytes;
  }

  symlink(targetText: string, value: string): void {
    const link = this.resolve(value, false);
    if (this.nodes.has(link)) throw new FsError('EEXIST', link);
    this.parentOf(link);
    this.nodes.set(link, { kind: 'symlink', target: targetText });
  }

  chmod(value: string, mode: number): void {
    const target = this.resolve(value, true);
    const node = this.nodes.get(target);
    if (!node) throw new FsError('ENOENT', target);
    if (node.kind !== 'symlink') node.mode = mode;
  }

  rename(from: string, to: string): void {
    const source = this.resolve(from, false);
    const target = this.resolve(to, false);
    const node = this.nodes.get(source);
    if (!node) throw new FsError('ENOENT', source);
    this.parentOf(target);
    for (const [key, value] of [...this.nodes]) {
      if (key === source || key.startsWith(`${source}/`)) {
        this.nodes.delete(key);
        this.nodes.set(target + key.slice(source.length), value);
      }
    }
  }

  remove(value: string): void {
    const target = this.resolve(value, false);
    if (!this.nodes.delete(target)) throw new FsError('ENOENT', target);
  }

  /** Every entry below a directory, without following links, relative to it. */
  list(root: string): FileEntry[] {
    const base = this.resolve(root, true);
    const node = this.nodes.get(base);
    if (!node) throw new FsError('ENOENT', base);
    if (node.kind !== 'dir') throw new FsError('ENOTDIR', base);
    const prefix = base === '/' ? '/' : `${base}/`;
    const entries: FileEntry[] = [];
    for (const [key, value] of this.nodes) {
      if (!key.startsWith(prefix) || key === base) continue;
      entries.push({
        path: key.slice(prefix.length),
        size: value.kind === 'file' ? value.bytes.byteLength : 0,
        mode: value.kind === 'symlink' ? 0o777 : value.mode & 0o7777,
        symlink: value.kind === 'symlink',
        directory: value.kind === 'dir',
      });
    }
    return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
}

// ---------------------------------------------------------------------------
// Network

const FAKE_ADDRESS = '203.0.113.10';

function addressBits(address: string): { family: 4 | 6; value: bigint } | null {
  const family = isIP(address);
  if (family === 4) {
    const value = address
      .split('.')
      .reduce((total, octet) => (total << 8n) | BigInt(Number(octet)), 0n);
    return { family, value };
  }
  if (family === 6) {
    const [head = '', tail = ''] = address.split('::');
    const left = head ? head.split(':') : [];
    const right = tail ? tail.split(':') : [];
    const groups = address.includes('::')
      ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
      : left;
    const value = groups.reduce((total, group) => (total << 16n) | BigInt(`0x${group || '0'}`), 0n);
    return { family, value };
  }
  return null;
}

function cidrContains(cidr: string, address: string): boolean {
  const [network = '', prefixText = ''] = cidr.split('/');
  const net = addressBits(network);
  const host = addressBits(address);
  if (!net || !host || net.family !== host.family) return false;
  const width = net.family === 4 ? 32n : 128n;
  const shift = width - BigInt(Number(prefixText));
  return net.value >> shift === host.value >> shift;
}

const domainMatches = (pattern: string, host: string): boolean =>
  pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern;

type Reach = 'allowed' | 'blocked' | 'unresolved';

/** Mirrors the documented provider behaviour: names are allow-listed on 80 and 443 only. */
export function fakeEgress(policy: EgressPolicy, host: string, port: number | null): Reach {
  const literal = isIP(host) !== 0;
  const name = host.toLowerCase();
  if (!literal) {
    const resolves =
      policy.kind === 'open' ||
      (policy.kind === 'domain_allowlist' &&
        policy.domains.some((domain) => domainMatches(domain, name))) ||
      (policy.kind === 'cidr_allowlist' &&
        policy.cidrs.some((cidr) => cidrContains(cidr, '8.8.8.8')));
    if (!resolves) return 'unresolved';
  }
  if (port === null) return 'allowed';
  switch (policy.kind) {
    case 'open':
      return 'allowed';
    case 'deny_all':
      return 'blocked';
    case 'cidr_allowlist':
      return policy.cidrs.some((cidr) => cidrContains(cidr, literal ? host : FAKE_ADDRESS))
        ? 'allowed'
        : 'blocked';
    case 'domain_allowlist':
      return !literal &&
        (port === 80 || port === 443) &&
        policy.domains.some((domain) => domainMatches(domain, name))
        ? 'allowed'
        : 'blocked';
  }
}

// ---------------------------------------------------------------------------
// Shell

type Part = { text: string; quoted: 'single' | 'double' | 'none' };
type Token = { type: 'word'; parts: Part[] } | { type: 'op'; value: string };
type Word = Part[];
type Redirect =
  | { kind: 'file'; stream: 'out' | 'append' | 'err' | 'errAppend'; target: Word }
  | { kind: 'errToOut' }
  | { kind: 'outToErr' };
type Command =
  | { kind: 'simple'; words: Word[]; redirects: Redirect[] }
  | { kind: 'subshell'; body: List; redirects: Redirect[] }
  | { kind: 'group'; body: List; redirects: Redirect[] };
type List = { command: Command; next: ';' | '&&' | '||' }[];

class ShellSyntaxError extends Error {}

function tokenize(script: string): Token[] {
  const tokens: Token[] = [];
  let parts: Part[] = [];
  let buffer = '';
  let started = false;
  const flushBuffer = () => {
    if (buffer) parts.push({ text: buffer, quoted: 'none' });
    buffer = '';
  };
  const endWord = () => {
    flushBuffer();
    if (started) tokens.push({ type: 'word', parts });
    parts = [];
    started = false;
  };
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index] as string;
    const next = script[index + 1];
    if (char === "'") {
      const close = script.indexOf("'", index + 1);
      if (close < 0) throw new ShellSyntaxError('unterminated quote');
      flushBuffer();
      parts.push({ text: script.slice(index + 1, close), quoted: 'single' });
      started = true;
      index = close;
    } else if (char === '"') {
      flushBuffer();
      let value = '';
      index += 1;
      while (index < script.length && script[index] !== '"') {
        if (script[index] === '\\' && ['"', '\\', '$'].includes(script[index + 1] ?? ''))
          index += 1;
        value += script[index];
        index += 1;
      }
      if (index >= script.length) throw new ShellSyntaxError('unterminated quote');
      parts.push({ text: value, quoted: 'double' });
      started = true;
    } else if (char === '\\') {
      flushBuffer();
      parts.push({ text: next ?? '', quoted: 'single' });
      started = true;
      index += 1;
    } else if (char === ' ' || char === '\t') {
      endWord();
    } else if (char === '\n' || char === ';') {
      endWord();
      tokens.push({ type: 'op', value: ';' });
    } else if ((char === '&' && next === '&') || (char === '|' && next === '|')) {
      endWord();
      tokens.push({ type: 'op', value: char + next });
      index += 1;
    } else if (char === '|' || char === '&') {
      throw new ShellSyntaxError(`${char} is not supported`);
    } else if (char === '(' || char === ')') {
      endWord();
      tokens.push({ type: 'op', value: char });
    } else if (char === '>') {
      // `2>` only when the 2 is a whole word of its own so far.
      let descriptor = '';
      if (buffer === '2' && parts.length === 0) {
        descriptor = '2';
        buffer = '';
        started = false;
      } else endWord();
      if (next === '>') {
        tokens.push({ type: 'op', value: `${descriptor}>>` });
        index += 1;
      } else if (next === '&') {
        const target = script[index + 2];
        tokens.push({ type: 'op', value: `${descriptor}>&${target}` });
        index += 2;
      } else {
        tokens.push({ type: 'op', value: `${descriptor}>` });
      }
    } else {
      buffer += char;
      started = true;
    }
  }
  endWord();
  return tokens;
}

const bare = (token: Token | undefined, value: string): boolean =>
  token?.type === 'word' &&
  token.parts.length === 1 &&
  token.parts[0]?.quoted === 'none' &&
  token.parts[0].text === value;

function parse(tokens: Token[]): List {
  let position = 0;
  const redirects = (): Redirect[] => {
    const found: Redirect[] = [];
    for (;;) {
      const token = tokens[position];
      if (token?.type !== 'op') return found;
      const value = token.value;
      if (value === '2>&1') found.push({ kind: 'errToOut' });
      else if (value === '>&2') found.push({ kind: 'outToErr' });
      else if (['>', '>>', '2>', '2>>'].includes(value)) {
        const target = tokens[position + 1];
        if (target?.type !== 'word') throw new ShellSyntaxError('a redirect needs a target');
        const stream =
          value === '>' ? 'out' : value === '>>' ? 'append' : value === '2>' ? 'err' : 'errAppend';
        found.push({ kind: 'file', stream, target: target.parts });
        position += 1;
      } else return found;
      position += 1;
    }
  };
  const command = (): Command | null => {
    const token = tokens[position];
    if (!token) return null;
    if (token.type === 'op' && token.value === '(') {
      position += 1;
      const body = list(')');
      const close = tokens[position];
      if (close?.type !== 'op' || close.value !== ')')
        throw new ShellSyntaxError('unterminated subshell');
      position += 1;
      return { kind: 'subshell', body, redirects: redirects() };
    }
    if (bare(token, '{')) {
      position += 1;
      const body = list('}');
      if (!bare(tokens[position], '}')) throw new ShellSyntaxError('unterminated group');
      position += 1;
      return { kind: 'group', body, redirects: redirects() };
    }
    const words: Word[] = [];
    const found: Redirect[] = [];
    for (;;) {
      const current = tokens[position];
      if (!current) break;
      if (current.type === 'word') {
        words.push(current.parts);
        position += 1;
        continue;
      }
      if (['>', '>>', '2>', '2>>', '2>&1', '>&2'].includes(current.value)) {
        found.push(...redirects());
        continue;
      }
      break;
    }
    return words.length || found.length ? { kind: 'simple', words, redirects: found } : null;
  };
  const list = (terminator: string | null): List => {
    const items: List = [];
    for (;;) {
      const token = tokens[position];
      if (!token) break;
      if (terminator === ')' && token.type === 'op' && token.value === ')') break;
      if (terminator === '}' && bare(token, '}')) break;
      if (token.type === 'op' && token.value === ';') {
        position += 1;
        continue;
      }
      const parsed = command();
      if (!parsed) throw new ShellSyntaxError('unexpected token');
      const separator = tokens[position];
      let next: ';' | '&&' | '||' = ';';
      if (separator?.type === 'op' && (separator.value === '&&' || separator.value === '||')) {
        next = separator.value;
        position += 1;
      }
      items.push({ command: parsed, next });
    }
    return items;
  };
  const result = list(null);
  if (position < tokens.length) throw new ShellSyntaxError('unexpected token');
  return result;
}

class ExitSignal {
  constructor(readonly code: number) {}
}

export class KilledSignal extends Error {}

type Sink = (bytes: Uint8Array) => void;
type Io = { out: Sink; err: Sink };

type Shell = {
  sandbox: FakeSandbox;
  process: FakeProcess;
  cwd: string;
  vars: Map<string, string>;
  status: number;
};

function expand(word: Word, shell: Shell): string {
  return word
    .map((part) =>
      part.quoted === 'single'
        ? part.text
        : part.text.replace(
            /\$(\?|\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/g,
            (_, name: string) => {
              if (name === '?') return String(shell.status);
              const key = name.startsWith('{') ? name.slice(1, -1) : name;
              return shell.vars.get(key) ?? shell.sandbox.env[key] ?? '';
            },
          ),
    )
    .join('');
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new KilledSignal());
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new KilledSignal());
      },
      { once: true },
    );
  });

function printfFormat(format: string, args: string[]): string {
  let used = 0;
  return format
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/%%|%s|%d/g, (token) => {
      if (token === '%%') return '%';
      const value = args[used] ?? '';
      used += 1;
      return token === '%d' ? String(Number.parseInt(value, 10) || 0) : value;
    });
}

async function program(argv: string[], shell: Shell, io: Io): Promise<number> {
  const name = (argv[0] ?? '').replace(/^\/(usr\/)?bin\//, '');
  const args = argv.slice(1);
  const { fs } = shell.sandbox;
  const err = (message: string) => io.err(encode(`${name}: ${message}\n`));
  const fail = (message: string, status: number) => {
    err(message);
    return status;
  };
  const path = (value: string) => fs.absolute(shell.cwd, value);
  switch (name) {
    case 'true':
      return 0;
    case 'false':
      return 1;
    case 'exit':
      throw new ExitSignal(args[0] === undefined ? shell.status : Number(args[0]) & 0xff);
    case 'echo':
      io.out(encode(`${args.join(' ')}\n`));
      return 0;
    case 'printf':
      io.out(encode(printfFormat(args[0] ?? '', args.slice(1))));
      return 0;
    case 'sleep':
      await sleep(Number(args[0] ?? '0') * 1000, shell.process.controller.signal);
      return 0;
    case 'env':
      io.out(
        encode(
          Object.entries(shell.sandbox.env)
            .map(([key, value]) => `${key}=${value}\n`)
            .join(''),
        ),
      );
      return 0;
    case 'sh':
      if (args[0] !== '-c' || args[1] === undefined) return fail('only -c is supported', 2);
      return runScript(args[1], shell.sandbox, shell.process, shell.cwd, io);
    case 'setsid':
      return program(args, shell, io);
    case 'head': {
      if (args[0] !== '-c' || args[2] === undefined) return fail('only -c N FILE is supported', 2);
      const count = Number(args[1]);
      if (args[2] === '/dev/zero') {
        const chunk = 65_536;
        for (let written = 0; written < count; written += chunk) {
          shell.process.controller.signal.throwIfAborted();
          io.out(new Uint8Array(Math.min(chunk, count - written)));
        }
        return 0;
      }
      io.out(fs.readFile(path(args[2])).slice(0, count));
      return 0;
    }
    case 'cat': {
      if (!args.length) {
        io.out(await shell.process.readStdin());
        return 0;
      }
      for (const file of args) {
        try {
          io.out(fs.readFile(path(file)));
        } catch {
          err(`${file}: No such file or directory`);
          return 1;
        }
      }
      return 0;
    }
    case 'mkdir': {
      const parents = args.includes('-p');
      for (const dir of args.filter((arg) => arg !== '-p' && arg !== '--')) {
        try {
          fs.mkdir(path(dir), parents);
        } catch (error) {
          err(`cannot create directory '${dir}': ${(error as FsError).code ?? 'error'}`);
          return 1;
        }
      }
      return 0;
    }
    case 'mv': {
      const [from, to] = args.filter((arg) => arg !== '-f' && arg !== '--');
      if (!from || !to) return fail('missing operand', 1);
      try {
        fs.rename(path(from), path(to));
        return 0;
      } catch {
        return fail(`cannot move '${from}'`, 1);
      }
    }
    case 'rm': {
      const force = args.includes('-f');
      for (const file of args.filter((arg) => arg !== '-f' && arg !== '--')) {
        try {
          fs.remove(path(file));
        } catch {
          if (!force) return fail(`cannot remove '${file}'`, 1);
        }
      }
      return 0;
    }
    case 'ln': {
      if (args[0] !== '-s' || !args[1] || !args[2]) return fail('only ln -s is supported', 1);
      try {
        fs.symlink(args[1], path(args[2]));
        return 0;
      } catch {
        return fail(`failed to create symbolic link '${args[2]}'`, 1);
      }
    }
    case 'chmod': {
      const operands = args.filter((arg) => arg !== '--');
      const mode = Number.parseInt(operands[0] ?? '', 8);
      if (!Number.isFinite(mode)) return fail('invalid mode', 1);
      try {
        for (const file of operands.slice(1)) fs.chmod(path(file), mode);
        return 0;
      } catch {
        return fail('cannot access file', 1);
      }
    }
    case 'chown': {
      // One user: ownership changes nothing, but the file has to exist.
      const operands = args.filter((arg) => arg !== '--');
      return operands.slice(1).every((file) => fs.stat(path(file)) !== undefined) ? 0 : 1;
    }
    case 'kill': {
      const target = args.filter((arg) => arg !== '--' && !/^-(KILL|9|TERM|15)$/.test(arg))[0];
      const pid = Number((target ?? '').replace(/^-/, ''));
      const victim = shell.sandbox.processes.get(pid);
      if (!victim) return fail(`(${target}) - No such process`, 1);
      victim.kill();
      return 0;
    }
    case 'getent': {
      if (args[0] !== 'hosts' || !args[1]) return 1;
      if (fakeEgress(shell.sandbox.egress, args[1], null) === 'unresolved') return 2;
      io.out(encode(`${isIP(args[1]) ? args[1] : FAKE_ADDRESS}       ${args[1]}\n`));
      return 0;
    }
    case 'curl':
      return curl(args, shell, io);
    default:
      io.err(encode(`sh: 1: ${argv[0]}: not found\n`));
      return 127;
  }
}

async function curl(args: string[], shell: Shell, io: Io): Promise<number> {
  let output: string | null = null;
  let writeOut = '';
  let url: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === '-o') output = args[++index] ?? null;
    else if (arg === '-w') writeOut = args[++index] ?? '';
    else if (arg === '-m' || arg === '--max-time' || arg === '--connect-timeout') index += 1;
    else if (!arg.startsWith('-')) url = arg;
  }
  if (!url) return 2;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 3;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  const reach = fakeEgress(shell.sandbox.egress, host, port);
  const finish = (code: string) =>
    io.out(encode(printfFormat(writeOut.replace('%{http_code}', code), [])));
  if (reach === 'unresolved') {
    finish('000');
    io.err(encode(`curl: (6) Could not resolve host: ${host}\n`));
    return 6;
  }
  if (reach === 'blocked') {
    finish('000');
    io.err(encode('curl: (28) Connection timed out after 5000 milliseconds\n'));
    return 28;
  }
  const body = encode('fake sandbox network response\n');
  if (output === '/dev/null') {
    // discarded
  } else if (output) shell.sandbox.fs.writeFile(shell.sandbox.fs.absolute(shell.cwd, output), body);
  else io.out(body);
  finish('200');
  return 0;
}

async function runCommand(command: Command, shell: Shell, io: Io): Promise<number> {
  shell.process.controller.signal.throwIfAborted();
  let current = io;
  for (const redirect of command.redirects) {
    if (redirect.kind === 'errToOut') current = { ...current, err: current.out };
    else if (redirect.kind === 'outToErr') current = { ...current, out: current.err };
    else {
      const target = expand(redirect.target, shell);
      let sink: Sink;
      if (target === '/dev/null') sink = () => {};
      else {
        const file = shell.sandbox.fs.absolute(shell.cwd, target);
        try {
          if (redirect.stream === 'out' || redirect.stream === 'err')
            shell.sandbox.fs.writeFile(file, EMPTY);
          else shell.sandbox.fs.writeFile(file, EMPTY, { append: true });
        } catch (error) {
          io.err(encode(`sh: 1: cannot create ${target}: ${(error as FsError).code}\n`));
          return 2;
        }
        sink = (bytes) => shell.sandbox.fs.writeFile(file, bytes, { append: true });
      }
      if (redirect.stream === 'out' || redirect.stream === 'append')
        current = { ...current, out: sink };
      else current = { ...current, err: sink };
    }
  }
  if (command.kind === 'subshell') {
    const child: Shell = { ...shell, vars: new Map(shell.vars) };
    try {
      return await runList(command.body, child, current);
    } catch (error) {
      if (error instanceof ExitSignal) return error.code;
      throw error;
    }
  }
  if (command.kind === 'group') return runList(command.body, shell, current);
  const words = command.words.map((word) => expand(word, shell));
  let first = 0;
  while (first < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[first] as string)) {
    const assignment = words[first] as string;
    const at = assignment.indexOf('=');
    shell.vars.set(assignment.slice(0, at), assignment.slice(at + 1));
    first += 1;
  }
  if (first === words.length) return 0;
  return program(words.slice(first), shell, current);
}

async function runList(list: List, shell: Shell, io: Io): Promise<number> {
  let skip: '&&' | '||' | null = null;
  for (const item of list) {
    const run =
      skip === null ||
      (skip === '&&' && shell.status === 0) ||
      (skip === '||' && shell.status !== 0);
    if (run) shell.status = await runCommand(item.command, shell, io);
    skip = item.next === ';' ? null : item.next;
  }
  return shell.status;
}

async function runScript(
  script: string,
  sandbox: FakeSandbox,
  owner: FakeProcess,
  cwd: string,
  io: Io,
): Promise<number> {
  let list: List;
  try {
    list = parse(tokenize(script));
  } catch (error) {
    io.err(encode(`sh: 1: Syntax error: ${(error as Error).message}\n`));
    return 2;
  }
  const shell: Shell = { sandbox, process: owner, cwd, vars: new Map(), status: 0 };
  try {
    return await runList(list, shell, io);
  } catch (error) {
    if (error instanceof ExitSignal) return error.code;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Sandboxes and processes

export class FakeProcess {
  readonly controller = new AbortController();
  finished = false;
  private readonly input: Uint8Array[] = [];
  private endInput: () => void = () => {};
  private readonly inputEnded = new Promise<void>((resolve) => {
    this.endInput = resolve;
  });
  constructor(
    readonly pid: number,
    readonly done: Promise<{ exitCode: number | null; killed: boolean }>,
  ) {}
  kill(): void {
    this.controller.abort();
  }
  writeStdin(bytes: Uint8Array): void {
    this.input.push(bytes);
  }
  closeStdin(): void {
    this.endInput();
  }
  /** Everything written to stdin, once it is closed. */
  async readStdin(): Promise<Uint8Array> {
    await new Promise<void>((resolve, reject) => {
      if (this.controller.signal.aborted) return reject(new KilledSignal());
      this.controller.signal.addEventListener('abort', () => reject(new KilledSignal()), {
        once: true,
      });
      void this.inputEnded.then(resolve);
    });
    const out = new Uint8Array(this.input.reduce((total, chunk) => total + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of this.input) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}

export type FakeSandbox = {
  id: string;
  image: string;
  egress: EgressPolicy;
  labels: Record<string, string>;
  env: Record<string, string>;
  state: 'running' | 'paused';
  fs: FakeFs;
  processes: Map<number, FakeProcess>;
  nextPid: number;
  expiry: ReturnType<typeof setTimeout> | null;
};

export class FakeSandboxEngine {
  readonly sandboxes = new Map<string, FakeSandbox>();
  private counter = 0;

  create(
    spec: Pick<SandboxSpec, 'image' | 'egress' | 'labels' | 'env' | 'lifetimeSeconds'>,
  ): FakeSandbox {
    this.counter += 1;
    const id = `fake-sbx-${String(this.counter).padStart(4, '0')}`;
    const sandbox: FakeSandbox = {
      id,
      image: spec.image,
      egress: structuredClone(spec.egress) as EgressPolicy,
      labels: { ...spec.labels },
      // What a fresh login shell has, and what the service chose. Nothing from
      // this process's own environment crosses.
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: '/home/user',
        USER: 'user',
        LOGNAME: 'user',
        ...spec.env,
      },
      state: 'running',
      fs: new FakeFs(),
      processes: new Map(),
      nextPid: 1000,
      expiry: null,
    };
    sandbox.expiry = setTimeout(() => this.destroy(id), spec.lifetimeSeconds * 1000);
    sandbox.expiry.unref?.();
    this.sandboxes.set(id, sandbox);
    return sandbox;
  }

  get(id: string): FakeSandbox | undefined {
    return this.sandboxes.get(id);
  }

  destroy(id: string): boolean {
    const sandbox = this.sandboxes.get(id);
    if (!sandbox) return false;
    for (const process of sandbox.processes.values()) process.kill();
    if (sandbox.expiry) clearTimeout(sandbox.expiry);
    this.sandboxes.delete(id);
    return true;
  }

  spawn(
    sandbox: FakeSandbox,
    argv: readonly string[],
    /** Bytes to deliver and close, or `open` to leave stdin for later writes. */
    options: { cwd: string; stdin?: Uint8Array | 'open'; onOutput: Sink },
  ): FakeProcess {
    sandbox.nextPid += 1;
    const pid = sandbox.nextPid;
    let resolveDone: (value: { exitCode: number | null; killed: boolean }) => void = () => {};
    const done = new Promise<{ exitCode: number | null; killed: boolean }>((resolve) => {
      resolveDone = resolve;
    });
    const child = new FakeProcess(pid, done);
    if (options.stdin !== 'open') {
      if (options.stdin) child.writeStdin(options.stdin);
      child.closeStdin();
    }
    sandbox.processes.set(pid, child);
    const io: Io = { out: options.onOutput, err: options.onOutput };
    const shell: Shell = { sandbox, process: child, cwd: options.cwd, vars: new Map(), status: 0 };
    void (async () => {
      let result: { exitCode: number | null; killed: boolean };
      try {
        if (!sandbox.fs.stat(options.cwd)) throw new FsError('ENOENT', options.cwd);
        result = { exitCode: await program([...argv], shell, io), killed: false };
      } catch (error) {
        if (error instanceof ExitSignal) result = { exitCode: error.code, killed: false };
        else if (error instanceof KilledSignal || child.controller.signal.aborted)
          result = { exitCode: null, killed: true };
        else {
          io.err(encode(`sh: ${(error as Error).message}\n`));
          result = { exitCode: 126, killed: false };
        }
      }
      child.finished = true;
      sandbox.processes.delete(pid);
      resolveDone(result);
    })();
    return child;
  }
}

class Capture {
  private readonly chunks: Uint8Array[] = [];
  private kept = 0;
  total = 0;
  constructor(private readonly max: number) {}
  push(bytes: Uint8Array): void {
    this.total += bytes.byteLength;
    const room = this.max - this.kept;
    if (room <= 0) return;
    const slice = bytes.slice(0, room);
    this.chunks.push(slice);
    this.kept += slice.byteLength;
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.kept);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}

export type AcknowledgementLoss = 'before_marker' | 'after_marker';

export class FakeSandboxProvider implements SandboxProvider {
  readonly capabilities: SandboxCapabilities;
  readonly engine: FakeSandboxEngine;
  readonly calls = { create: 0, exec: 0, destroy: 0 };
  private pendingLoss: AcknowledgementLoss | null = null;

  constructor(
    options: { capabilities?: Partial<SandboxCapabilities>; engine?: FakeSandboxEngine } = {},
  ) {
    this.capabilities = { ...FAKE_CAPABILITIES, ...options.capabilities };
    this.engine = options.engine ?? new FakeSandboxEngine();
  }

  /** The next command's acknowledgement is lost before or after its marker is written. */
  loseNextAcknowledgement(when: AcknowledgementLoss): void {
    this.pendingLoss = when;
  }

  /** The provider forgets a sandbox without being asked, the way a crashed host does. */
  vanish(id: string): void {
    this.engine.destroy(id);
  }

  private running(handle: SandboxHandle): FakeSandbox {
    const sandbox = this.engine.get(handle.providerSandboxId);
    if (!sandbox) throw new SandboxTransportError('the sandbox did not answer');
    if (sandbox.state !== 'running') throw new SandboxTransportError('the sandbox is paused');
    return sandbox;
  }

  async create(spec: SandboxSpec, signal: AbortSignal): Promise<SandboxHandle> {
    signal.throwIfAborted();
    this.calls.create += 1;
    if (!this.capabilities.egress.includes(spec.egress.kind))
      throw new Error(`the fake provider cannot enforce ${spec.egress.kind}`);
    if (spec.lifetimeSeconds > this.capabilities.maxLifetimeSeconds)
      throw new Error('the fake provider refuses a lifetime above its maximum');
    const sandbox = this.engine.create(spec);
    sandbox.fs.mkdir(spec.workdir, true);
    return { providerSandboxId: sandbox.id, imageDigest: null, region: null };
  }

  async connect(handle: SandboxHandle, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.running(handle);
  }

  async exec(handle: SandboxHandle, spec: ExecSpec, signal: AbortSignal): Promise<ExecOutcome> {
    const sandbox = this.running(handle);
    this.calls.exec += 1;
    const loss = this.pendingLoss;
    this.pendingLoss = null;
    if (loss === 'before_marker')
      throw new SandboxTransportError('the request was lost before it reached the sandbox');
    const started = performance.now();
    const channel = new Capture(spec.maxOutputBytes);
    const child = this.engine.spawn(sandbox, spec.argv, {
      cwd: spec.cwd,
      stdin: spec.stdin,
      onOutput: (bytes) => channel.push(bytes),
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, spec.timeoutMs);
    void child.done.then(() => clearTimeout(timer));
    // The acknowledgement can be cut while the command keeps running, exactly
    // as a dropped connection leaves a remote process alive.
    const cut = new Promise<'cut'>((resolve) => {
      if (signal.aborted) return resolve('cut');
      signal.addEventListener('abort', () => resolve('cut'), { once: true });
      if (loss === 'after_marker') {
        const poll = () => {
          if (child.finished || sandbox.fs.lstat(markerDirectory(spec.marker)) !== undefined)
            resolve('cut');
          else setTimeout(poll, 2);
        };
        poll();
      }
    });
    const result = await Promise.race([child.done, cut]);
    if (result === 'cut')
      throw new SandboxTransportError('the connection dropped before the command answered');
    return {
      state: result.killed ? 'killed' : 'exited',
      exitCode: result.killed ? null : result.exitCode,
      signal: result.killed ? 'SIGKILL' : null,
      timedOut: result.killed && timedOut,
      durationMs: Math.round(performance.now() - started),
      output: channel.bytes(),
      totalBytes: channel.total,
      captureLimited: channel.total > spec.maxOutputBytes,
    };
  }

  reattach(handle: SandboxHandle, marker: string, signal: AbortSignal) {
    return reattachByMarker(this, handle, marker, signal);
  }

  async putFiles(
    handle: SandboxHandle,
    files: AsyncIterable<{ path: string; bytes: Uint8Array; mode: number }>,
    signal: AbortSignal,
  ): Promise<void> {
    const sandbox = this.running(handle);
    for await (const file of files) {
      signal.throwIfAborted();
      if (!file.path.startsWith('/') || file.path.split('/').includes('..'))
        throw new Error('an upload path must be absolute');
      if (file.bytes.byteLength > this.capabilities.maxUploadBytes)
        throw new Error('the upload is above the provider limit');
      sandbox.fs.writeFile(file.path, file.bytes, { mode: file.mode, parents: true });
    }
  }

  async listFiles(handle: SandboxHandle, root: string, signal: AbortSignal): Promise<FileEntry[]> {
    signal.throwIfAborted();
    const sandbox = this.running(handle);
    try {
      return sandbox.fs.list(root);
    } catch (error) {
      if (error instanceof FsError && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))
        throw new SandboxFileNotFound(`no such directory: ${root}`);
      throw error;
    }
  }

  async getFile(
    handle: SandboxHandle,
    path: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    signal.throwIfAborted();
    const sandbox = this.running(handle);
    try {
      return sandbox.fs.readFile(path).slice(0, maxBytes);
    } catch (error) {
      if (error instanceof FsError && error.code === 'ENOENT')
        throw new SandboxFileNotFound(`no such file: ${path}`);
      throw error;
    }
  }

  async pause(handle: SandboxHandle, signal: AbortSignal): Promise<{ resumeRef: string }> {
    signal.throwIfAborted();
    const sandbox = this.engine.get(handle.providerSandboxId);
    if (!sandbox) throw new Error('the sandbox is gone');
    sandbox.state = 'paused';
    return { resumeRef: sandbox.id };
  }

  async resume(resumeRef: string, signal: AbortSignal): Promise<SandboxHandle> {
    signal.throwIfAborted();
    const sandbox = this.engine.get(resumeRef);
    if (!sandbox) throw new Error('the sandbox is gone');
    sandbox.state = 'running';
    return { providerSandboxId: sandbox.id, imageDigest: null, region: null };
  }

  async destroy(handle: SandboxHandle, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.calls.destroy += 1;
    this.engine.destroy(handle.providerSandboxId);
  }

  async inspect(
    handle: SandboxHandle,
    signal: AbortSignal,
  ): Promise<'running' | 'paused' | 'gone'> {
    signal.throwIfAborted();
    return this.engine.get(handle.providerSandboxId)?.state ?? 'gone';
  }

  async reconcile(
    project: string,
    live: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<string[]> {
    signal.throwIfAborted();
    const destroyed: string[] = [];
    for (const sandbox of [...this.engine.sandboxes.values()]) {
      if (!ownedLabels(sandbox.labels, project)) continue;
      const session = sandbox.labels[LABEL_SESSION];
      if (live.has(sandbox.id) || (session !== undefined && live.has(session))) continue;
      this.engine.destroy(sandbox.id);
      destroyed.push(sandbox.id);
    }
    return destroyed;
  }
}

export const fakeText = decode;
