/**
 * Spike: the same small web tasks through the browser worker and through Cua
 * Driver, with steps, time and the first failure of each recorded.
 *
 *   bun apps/melete/spike/cua-compare.ts [melete|cua|both] [out.json]
 *
 * Both sides receive the same semantic steps (open, fill by label, check,
 * choose, submit, follow a link, read). Each side resolves them against its
 * own observation of the page; nothing is hard-coded to a page's internals.
 * Public test sites only, no accounts.
 *
 * CUA_DRIVER_BIN points at the driver; CUA_DELIVERY is `background` (default)
 * or `foreground` (for a browser nobody else uses, as on a CI display).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CuaDriverBrowser, CuaStepRefused } from '../src/sandbox/adapters/cua-driver.ts';
import { BrowserWorkerPool } from '../src/workers/browser/client.ts';

interface Backend {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  open(url: string): Promise<void>;
  fill(label: string, value: string): Promise<void>;
  check(role: 'radio' | 'checkbox', label: string): Promise<void>;
  select(label: string, option: string): Promise<void>;
  submit(name: string): Promise<void>;
  follow(name: string): Promise<void>;
  /** Visible text, row structure kept where the side keeps it. */
  text(): Promise<string>;
  /** Driver-level calls so far (observations included). */
  callCount(): number;
  refusals(): string[];
  /** What the side saw last, for a failure record. */
  diagnostics(): string;
}

// ── The browser worker, as the service drives it ───────────────────────────

type Observation = {
  id: string;
  url: string;
  tree: string;
  schema: { label: string; role: string }[];
};
type CommandResult = {
  session_id: string;
  control_epoch: number;
  observation?: Observation;
  result?: { submit_intents?: { name: string }[]; text?: string } & Record<string, unknown>;
};

class MeleteBackend implements Backend {
  readonly name = 'melete';
  private pool?: BrowserWorkerPool;
  private client?: Awaited<ReturnType<BrowserWorkerPool['get']>>;
  private session = { id: '', epoch: 0 };
  private last?: Observation;
  private intents: { name: string }[] = [];
  private calls = 0;
  private refused: string[] = [];

  async start() {
    const root = join(tmpdir(), `melete-spike-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    this.pool = new BrowserWorkerPool({ spacesRoot: root, allowLocalProcess: true });
    // A cold start on a slow machine can miss the pool's ten-second window once.
    for (let attempt = 0; ; attempt++) {
      try {
        this.client = await this.pool.get('sp_spike');
        break;
      } catch (error) {
        if (attempt >= 2) throw error;
      }
    }
    const lease = await this.client.lease('job_spike', {
      public_compartment: true,
      allowed_domains: [],
    });
    this.session = { id: lease.id, epoch: lease.control_epoch };
    await this.command({ kind: 'observe' });
  }

  private async command(operation: Record<string, unknown>): Promise<CommandResult> {
    if (!this.client) throw new Error('not started');
    this.calls++;
    try {
      const result = await this.client.request<CommandResult>('/command', {
        session_id: this.session.id,
        job_id: 'job_spike',
        control_epoch: this.session.epoch,
        operation,
      });
      if (result.observation) this.last = result.observation;
      if (result.result?.submit_intents) this.intents = result.result.submit_intents;
      if (process.env.SPIKE_DEBUG)
        console.error(
          `[melete] ${operation.kind} -> intents ${JSON.stringify(result.result?.submit_intents?.map((i) => i.name))} keys ${Object.keys(result.result ?? {})} obs ${Boolean(result.observation)}`,
        );
      return result;
    } catch (error) {
      const reason = (error as { reason?: string }).reason ?? (error as Error).message;
      this.refused.push(`${operation.kind}: ${reason}`);
      throw error;
    }
  }

  private label(role: string, wanted: string): string {
    const norm = (t: string) => t.replace(/\s+/g, ' ').trim().replace(/:$/, '').toLowerCase();
    const hit = this.last?.schema.find((c) => c.role === role && norm(c.label) === norm(wanted));
    return (hit?.label ?? wanted).trim();
  }

  async open(url: string) {
    await this.command({ kind: 'open', url });
  }
  async fill(label: string, value: string) {
    await this.command({ kind: 'fill', label: this.label('textbox', label), value });
  }
  async check(role: 'radio' | 'checkbox', label: string) {
    await this.command({ kind: 'click', role, name: this.label(role, label) });
  }
  async select(label: string, option: string) {
    await this.command({ kind: 'select', label: this.label('combobox', label), value: option });
  }
  async submit(name: string) {
    if (!this.intents.some((intent) => intent.name === name))
      await this.command({ kind: 'observe' });
    const intent = this.intents.find((i) => i.name === name);
    if (!intent) throw new Error(`no submit intent for "${name}"`);
    await this.command({ kind: 'submit', intent });
  }
  /** A link is a commit control here: clicking it is refused, so open its address instead. */
  async follow(name: string) {
    try {
      await this.command({ kind: 'click', role: 'link', name });
      return;
    } catch {
      // Recorded as a refusal; fall through to the address the tree shows.
    }
    const tree = this.last?.tree ?? '';
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`link "${escaped}"[^\\n]*\\n\\s*- /url: (\\S+)`).exec(tree);
    if (!match?.[1]) throw new Error(`no address for link "${name}"`);
    await this.command({ kind: 'open', url: new URL(match[1], this.last?.url).href });
  }
  async text() {
    await this.command({ kind: 'observe' });
    return this.last?.tree ?? '';
  }
  callCount() {
    return this.calls;
  }
  diagnostics() {
    return (this.last?.tree ?? '').slice(0, 2500);
  }
  refusals() {
    return this.refused;
  }
  async stop() {
    await this.pool?.close();
  }
}

// ── Cua Driver ─────────────────────────────────────────────────────────────

class CuaBackend implements Backend {
  readonly name = 'cua';
  private browser: CuaDriverBrowser;
  private refused: string[] = [];

  constructor() {
    const home = join(tmpdir(), `cua-spike-home-${Date.now()}`);
    mkdirSync(home, { recursive: true });
    const binary = process.env.CUA_DRIVER_BIN;
    if (!binary) throw new Error('CUA_DRIVER_BIN is not set');
    this.browser = new CuaDriverBrowser(
      {
        binary,
        env: {
          ...(process.env as Record<string, string>),
          HOME: home,
          USERPROFILE: home,
          LOCALAPPDATA: join(home, 'AppData', 'Local'),
          XDG_STATE_HOME: join(home, '.local', 'state'),
          CUA_DRIVER_BROWSER_PROFILE_ROOT: join(home, 'BrowserProfiles'),
          CUA_DRIVER_RS_TELEMETRY_ENABLED: '0',
          CUA_TELEMETRY_ENABLED: '0',
          CUA_DRIVER_RS_UPDATE_CHECK: 'false',
        },
      },
      {
        session: 'spike',
        delivery: process.env.CUA_DELIVERY === 'foreground' ? 'foreground' : 'background',
      },
    );
    mkdirSync(join(home, 'BrowserProfiles'), { recursive: true });
    mkdirSync(join(home, 'AppData', 'Local'), { recursive: true });
  }

  private async guard<T>(op: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof CuaStepRefused) this.refused.push(`${op}: ${error.code}`);
      else this.refused.push(`${op}: ${(error as Error).message.slice(0, 120)}`);
      throw error;
    }
  }

  start() {
    return this.guard('start', () => this.browser.start());
  }
  open(url: string) {
    return this.guard('open', () => this.browser.open(url));
  }
  fill(label: string, value: string) {
    return this.guard('fill', () => this.browser.fill(label, value));
  }
  check(role: 'radio' | 'checkbox', label: string) {
    return this.guard('check', () => this.browser.check(role, label));
  }
  select(label: string, option: string) {
    return this.guard('select', () => this.browser.select(label, option));
  }
  submit(name: string) {
    return this.guard('submit', () => this.browser.click(['button'], name));
  }
  follow(name: string) {
    return this.guard('follow', () => this.browser.click(['link'], name));
  }
  async text() {
    await this.guard('read', () => this.browser.snapshot());
    return this.browser.text();
  }
  callCount() {
    return this.browser.calls.length;
  }
  diagnostics() {
    return `notes: ${this.browser.notes.join('; ')}
refs:
${this.browser.refSummary()}
text:
${this.browser.text().slice(0, 1500)}`;
  }
  refusals() {
    return this.refused;
  }
  stop() {
    return this.browser.stop();
  }
}

// ── Tasks ──────────────────────────────────────────────────────────────────

type Task = {
  id: string;
  title: string;
  run(b: Backend): Promise<{ ok: boolean; detail: string }>;
};

const lines = (text: string) => text.split('\n');

const TASKS: Task[] = [
  {
    id: 'form',
    title: 'Fill and submit the httpbin pizza order form, then read the echoed order back',
    async run(b) {
      await b.open('https://httpbin.org/forms/post');
      await b.fill('Customer name', 'Ada Test');
      await b.fill('Telephone', '555-0100');
      await b.fill('E-mail address', 'ada@example.com');
      await b.check('radio', 'Medium');
      await b.check('checkbox', 'Bacon');
      await b.check('checkbox', 'Onion');
      await b.fill('Delivery instructions', 'Ring twice');
      await b.submit('Submit order');
      const text = await b.text();
      const want = [
        'Ada Test',
        '555-0100',
        'ada@example.com',
        'medium',
        'bacon',
        'onion',
        'Ring twice',
      ];
      const missing = want.filter((w) => !text.includes(w));
      return {
        ok: missing.length === 0,
        detail: missing.length ? `echo is missing ${missing.join(', ')}` : 'echo has every field',
      };
    },
  },
  {
    id: 'navigate',
    title: 'books.toscrape.com: open the Travel category, open its first book, read the price',
    async run(b) {
      await b.open('https://books.toscrape.com/');
      await b.follow('Travel');
      await b.follow("It's Only the Himalayas");
      const text = await b.text();
      return {
        ok: text.includes('£45.17'),
        detail: text.includes('£45.17') ? 'price £45.17 read' : 'price not found',
      };
    },
  },
  {
    id: 'table',
    title: 'the-internet tables: find who owes the most in Example 1, row kept together',
    async run(b) {
      await b.open('https://the-internet.herokuapp.com/tables');
      const text = await b.text();
      const row = lines(text).find(
        (l) => l.includes('Doe') && l.includes('Jason') && l.includes('$100.00'),
      );
      return {
        ok: Boolean(row),
        detail: row
          ? `row: ${row.trim().slice(0, 100)}`
          : 'no single line holds Doe, Jason and $100.00',
      };
    },
  },
  {
    id: 'dropdown',
    title: 'the-internet dropdown: choose Option 2 in an unlabelled select and read it back',
    async run(b) {
      await b.open('https://the-internet.herokuapp.com/dropdown');
      await b.select('Dropdown List', 'Option 2');
      const text = await b.text();
      const selected =
        /option "Option 2"[^\n]*selected|Option 2[^\n]*selected|combobox[^\n]*Option 2/i.test(text);
      return { ok: selected, detail: selected ? 'Option 2 selected' : 'selection not confirmed' };
    },
  },
];

type TaskResult = {
  backend: string;
  task: string;
  ok: boolean;
  detail: string;
  calls: number;
  ms: number;
  refusals: string[];
  error?: string;
  seen?: string;
};

async function runBackend(
  make: () => Backend,
): Promise<{ startMs: number; startError?: string; results: TaskResult[] }> {
  const backend = make();
  const started = performance.now();
  try {
    await backend.start();
  } catch (error) {
    await backend.stop().catch(() => {});
    return {
      startMs: Math.round(performance.now() - started),
      startError: `${(error as Error).name}: ${(error as Error).message}`.slice(0, 400),
      results: [],
    };
  }
  const startMs = Math.round(performance.now() - started);
  const results: TaskResult[] = [];
  for (const task of TASKS.filter(
    (t) => !process.env.SPIKE_ONLY || process.env.SPIKE_ONLY.split(',').includes(t.id),
  )) {
    const calls0 = backend.callCount();
    const refusals0 = backend.refusals().length;
    const t0 = performance.now();
    let outcome: { ok: boolean; detail: string } = { ok: false, detail: '' };
    let error: string | undefined;
    try {
      outcome = await task.run(backend);
    } catch (e) {
      error = `${(e as Error).name}: ${(e as Error).message}`.slice(0, 300);
    }
    results.push({
      backend: backend.name,
      task: task.id,
      ok: outcome.ok && !error,
      detail: outcome.detail,
      calls: backend.callCount() - calls0,
      ms: Math.round(performance.now() - t0),
      refusals: backend.refusals().slice(refusals0),
      error,
      ...(outcome.ok && !error ? {} : { seen: backend.diagnostics() }),
    });
    console.log(JSON.stringify(results.at(-1)));
  }
  await backend.stop().catch(() => {});
  return { startMs, results };
}

const which = process.argv[2] ?? 'both';
const out = process.argv[3] ?? 'cua-compare.json';
const report: Record<string, unknown> = {
  at: new Date().toISOString(),
  platform: process.platform,
  tasks: TASKS.map((t) => ({ id: t.id, title: t.title })),
};
if (which === 'melete' || which === 'both')
  report.melete = await runBackend(() => new MeleteBackend());
if (which === 'cua' || which === 'both') report.cua = await runBackend(() => new CuaBackend());
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`wrote ${out}`);
