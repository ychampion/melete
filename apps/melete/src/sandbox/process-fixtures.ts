/**
 * The computers' side of background processes, held in memory, for tests of
 * what the service records and wakes: each sandbox's processes, their output,
 * ports and exits, and each sandbox's boot. The real helper is tested in
 * `process-helper.test.ts`.
 */
import type { ProcessComputer, ProcessFacts, StartRequest } from './process-helper.ts';
import type { SandboxHandle, SandboxProvider } from './types.ts';

const encode = (value: string) => new TextEncoder().encode(value);

type FakeProcess = {
  id: string;
  boot: string;
  command: string;
  cwd: string;
  state: 'running' | 'exited';
  exitCode: number | null;
  out: Uint8Array;
  input: string;
  started: number;
  ports: number[];
};

/** The computers' side, held in memory: processes by sandbox, and each sandbox's boot. */
export class FakeComputers {
  readonly boots = new Map<string, string>();
  readonly processes = new Map<string, Map<string, FakeProcess>>();
  readonly calls: string[] = [];

  private of(sandbox: string) {
    if (!this.boots.has(sandbox)) this.boots.set(sandbox, `boot-${sandbox}-1`);
    let found = this.processes.get(sandbox);
    if (!found) {
      found = new Map();
      this.processes.set(sandbox, found);
    }
    return found;
  }

  get(sandbox: string, id: string) {
    return this.of(sandbox).get(id);
  }

  all(): FakeProcess[] {
    return [...this.processes.values()].flatMap((each) => [...each.values()]);
  }

  /** The computer restarted: every process in it is gone, under the old boot. */
  restart(sandbox: string) {
    const boot = this.boots.get(sandbox) ?? `boot-${sandbox}-1`;
    this.boots.set(sandbox, `${boot}+`);
  }

  /** The process ends by itself with this code. */
  exit(sandbox: string, id: string, code: number) {
    const process = this.of(sandbox).get(id);
    if (!process) throw new Error(`no process ${id}`);
    process.state = 'exited';
    process.exitCode = code;
    process.ports = [];
  }

  /** The process opens a port. */
  listen(sandbox: string, id: string, port: number) {
    const process = this.of(sandbox).get(id);
    if (!process) throw new Error(`no process ${id}`);
    process.ports = [...process.ports, port];
  }

  print(sandbox: string, id: string, value: string) {
    const process = this.of(sandbox).get(id);
    if (!process) throw new Error(`no process ${id}`);
    process.out = new Uint8Array([...process.out, ...encode(value)]);
  }

  private facts(sandbox: string, process: FakeProcess): ProcessFacts {
    const lost = process.boot !== this.boots.get(sandbox);
    return {
      id: process.id,
      state: lost ? 'lost' : process.state,
      exit_code: process.exitCode,
      cursor: process.out.byteLength,
      oldest: 0,
      last_line: new TextDecoder().decode(process.out).trimEnd().split('\n').pop()?.trim() || null,
      ports: process.ports,
      members: process.state === 'running' && !lost ? 1 : 0,
      started: process.started,
    };
  }

  computerFor = (_provider: SandboxProvider, target: SandboxHandle): ProcessComputer => {
    const sandbox = target.providerSandboxId;
    const mine = () => this.of(sandbox);
    const boot = () => this.boots.get(sandbox) ?? '';
    const must = (id: string) => {
      const found = mine().get(id);
      if (!found) throw new Error(`no process ${id}`);
      return found;
    };
    const end = (process: FakeProcess, code: number) => {
      if (process.state === 'running' && process.boot === boot()) {
        process.state = 'exited';
        process.exitCode = code;
      }
    };
    return {
      start: async (request: StartRequest) => {
        this.calls.push(`start ${request.id}`);
        if (mine().has(request.id)) return { outcome: 'reentered' };
        const out = encode(`started ${request.command}\n`);
        const process: FakeProcess = {
          id: request.id,
          boot: boot(),
          command: request.command,
          cwd: request.cwd,
          state: 'running',
          exitCode: null,
          out,
          input: '',
          started: Date.now(),
          ports: [],
        };
        mine().set(request.id, process);
        return {
          outcome: 'started',
          boot: boot(),
          process: this.facts(sandbox, process),
          read: { from: 0, next: out.byteLength, dropped: 0, total: out.byteLength },
          data: out,
        };
      },
      status: async (ids) => {
        this.calls.push('status');
        const wanted = ids === 'all' ? [...mine().keys()] : ids.filter((id) => mine().has(id));
        return {
          boot: boot(),
          processes: wanted.map((id) => this.facts(sandbox, must(id))),
          missing: ids === 'all' ? [] : ids.filter((id) => !mine().has(id)),
        };
      },
      read: async (id, cursor, maxBytes) => {
        this.calls.push(`read ${id}`);
        const process = must(id);
        const from = cursor < 0 ? Math.max(0, process.out.byteLength - maxBytes) : cursor;
        const data = process.out.slice(from, from + maxBytes);
        return {
          boot: boot(),
          process: this.facts(sandbox, process),
          read: { from, next: from + data.byteLength, dropped: 0, total: process.out.byteLength },
          data,
        };
      },
      write: async (id, bytes) => {
        this.calls.push(`write ${id}`);
        must(id).input += new TextDecoder().decode(bytes);
        return { written: bytes.byteLength };
      },
      signal: async (id, name) => {
        this.calls.push(`signal ${id} ${name}`);
        const process = must(id);
        end(process, name === 'KILL' ? 137 : 128 + { TERM: 15, INT: 2, HUP: 1 }[name]);
        return { boot: boot(), process: this.facts(sandbox, process) };
      },
      stop: async (id) => {
        this.calls.push(`stop ${id}`);
        const process = must(id);
        end(process, 143);
        return { boot: boot(), process: this.facts(sandbox, process) };
      },
    };
  };
}
