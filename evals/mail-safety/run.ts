import { Database } from 'bun:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import corpus from './corpus.json' with { type: 'json' };
import {
  identity,
  type Ledger,
  NEMOTRON,
  type Observation,
  type Usage,
  validateLedger,
} from './evidence.ts';
import { corpusHash, generate, sha256, validateCorpus, verifyManifest } from './generate.ts';
import { renderReport, report } from './grade.ts';
import {
  type Accounts,
  AppHttp,
  appendEmail,
  type CaseTarget,
  collect,
  preflight,
  readBytes,
  submitNotice,
} from './http.ts';

export type Attempt = {
  id: string;
  submissionId: string;
  phase: string;
  reservation?: string;
  threadId?: string;
  jobId?: string;
  cursor?: number;
  helperSurfaces?: string[];
  observation?: Observation;
  mailboxUid?: string;
};
export function nextAttempt<T extends { id: string; phase?: string }>(
  state: { attempts: T[] },
  id: string,
  limit: number,
) {
  const old = state.attempts.find((a) => a.id === id);
  if (old) return { attempt: old, resume: true };
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2 || state.attempts.length >= limit)
    throw new Error('At most two attempted items across the campaign');
  if (state.attempts.some((a) => a.phase !== 'settled'))
    throw new Error('Prior attempt remains unsettled');
  return { attempt: { id, submissionId: `mail-${id}`, phase: 'reserving' }, resume: false };
}
export function requireSettlement(
  o: { settled: boolean; usage: Usage[] },
  nemotron: boolean,
): void {
  if (
    !o.settled ||
    !o.usage.length ||
    o.usage.some(
      (u) => u.costUsd === null || !Number.isFinite(u.costUsd) || u.costUsd < 0 || !identity(u),
    )
  )
    throw new Error('Missing cost, identity or usage settlement');
  if (nemotron && o.usage.some((u) => identity(u) !== NEMOTRON))
    throw new Error('Wrong Nemotron identity');
}

/** Supplied by the isolated target operator, never inferred from the app spending settings.
 * verify must inspect actual pre-call enforcement, including all secondary/background calls.
 * This interface consumes an existing guard; it does not implement a budget proxy. */
export interface HardGuard {
  verify(scope: {
    targetId: string;
    campaignId: string;
    budgetUsd: number;
    maxItems: number;
  }): Promise<{
    proofId: string;
    targetId: string;
    campaignId: string;
    capUsd: number;
    maxItems: number;
    covers: string[];
    pending: number;
  }>;
  reserve(submissionId: string): Promise<{ receiptId: string }>;
  reconcile(submissionId: string): Promise<{
    receiptId: string;
    settled: boolean;
    costUsd: number | null;
    submission?: { threadId: string; jobId: string };
  }>;
}
type Account = { id: string; sessionRef: string };
export type Config = {
  version: 1;
  disposable: true;
  targetId: string;
  campaignId: string;
  baseUrl: string;
  corpusHash: string;
  corpusDir: string;
  requireNemotron: boolean;
  accounts: { owner: Account; helper: Account; outsider: Account };
  cases: Record<string, CaseTarget>;
  hardGuard?: { module: string; sha256: string; reference: string };
};
export async function loadGuard(config: Config): Promise<HardGuard> {
  const supplied = config.hardGuard;
  if (!supplied?.module || !supplied.reference || !/^[a-f0-9]{64}$/.test(supplied.sha256))
    throw new Error('No verified external hard guard supplied; paid execution disabled');
  const path = resolve(supplied.module);
  if (sha256(await readFile(path)) !== supplied.sha256)
    throw new Error('Hard guard implementation hash mismatch');
  const module = await import(pathToFileURL(path).href);
  if (typeof module.openGuard !== 'function') throw new Error('No hard guard verifier');
  return await module.openGuard(supplied.reference);
}

function emptyObservation(id: string, expectedHelper: string, phase: string): Observation {
  return {
    id,
    expectedHelper,
    requiredVisibility: 'everyone',
    rawAnswer: '',
    terminal: false,
    completed: false,
    jobIds: [],
    actionIds: [],
    receiptIds: [],
    boardBefore: [],
    ownerBoard: [],
    helperBoard: [],
    helperSurfaces: [],
    outsiderStatuses: [],
    usage: [],
    settled: false,
    error: phase,
  };
}
async function acquireLock(path: string) {
  const fs = await import('node:fs/promises');
  try {
    const file = await fs.open(path, 'wx', 0o600);
    await file.writeFile(String(process.pid));
    await file.sync();
    return file;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    const pid = Number(await fs.readFile(path, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid runner lock');
    try {
      process.kill(pid, 0);
    } catch (failure) {
      if (!(failure instanceof Error && 'code' in failure && failure.code === 'ESRCH'))
        throw failure;
      await fs.rename(path, `${path}.stale-${pid}`);
      return acquireLock(path);
    }
    throw new Error('Campaign runner is already active');
  }
}

class Journal {
  readonly db: Database;
  constructor(path: string, pin: string) {
    this.db = new Database(path, { create: true });
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS pin (value TEXT); CREATE TABLE IF NOT EXISTS attempt (id TEXT PRIMARY KEY, body TEXT NOT NULL)',
    );
    const old = this.db.query<{ value: string }, []>('SELECT value FROM pin').get();
    if (old && old.value !== pin) throw new Error('Resume configuration mismatch');
    if (!old) this.db.query('INSERT INTO pin VALUES (?)').run(pin);
  }
  list(): Attempt[] {
    return this.db
      .query<{ body: string }, []>('SELECT body FROM attempt ORDER BY rowid')
      .all()
      .map((a) => JSON.parse(a.body));
  }
  put(attempt: Attempt) {
    this.db
      .query('INSERT INTO attempt VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(attempt.id, JSON.stringify(attempt));
  }
  close() {
    this.db.close();
  }
}

function clientsFor(config: Config) {
  const account = (role: keyof Config['accounts']) => {
    const session = process.env[config.accounts[role].sessionRef];
    if (!session) throw new Error('Session reference unavailable');
    return new AppHttp(config.baseUrl, session);
  };
  return { owner: account('owner'), helper: account('helper'), outsider: account('outsider') };
}
async function writeArtifact(out: string, config: Config, journal: Journal) {
  const observations = journal
    .list()
    .map((a) => a.observation ?? emptyObservation(a.id, config.accounts.helper.id, a.phase));
  await writeFile(
    resolve(out, 'run.json'),
    `${JSON.stringify(
      {
        version: 1,
        corpusHash: corpusHash(),
        targetId: config.targetId,
        campaignId: config.campaignId,
        observations,
        pending: journal
          .list()
          .filter((a) => a.phase !== 'settled')
          .map((a) => a.id),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

export async function runCampaign(
  config: Config,
  out: string,
  limit: number,
  budgetUsd: number,
  guard: HardGuard,
): Promise<void> {
  validateCorpus(corpus);
  if (
    config.version !== 1 ||
    config.disposable !== true ||
    !config.targetId ||
    !config.campaignId ||
    config.corpusHash !== corpusHash() ||
    !config.baseUrl ||
    !config.corpusDir ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 2 ||
    !Number.isFinite(budgetUsd) ||
    budgetUsd <= 0 ||
    budgetUsd > 0.25
  )
    throw new Error(
      'Explicit isolated target, corpus hash, two-item limit and dollar cap required',
    );
  const selected = Object.keys(config.cases);
  if (
    !selected.length ||
    selected.some((id) => !corpus.cases.some((c) => c.id === id)) ||
    new Set(Object.values(config.cases).map((c) => c.roomId)).size !== selected.length
  )
    throw new Error('Dedicated unique case namespaces required');
  const proof = await guard.verify({
    targetId: config.targetId,
    campaignId: config.campaignId,
    budgetUsd,
    maxItems: 2,
  });
  if (
    !proof.proofId ||
    proof.targetId !== config.targetId ||
    proof.campaignId !== config.campaignId ||
    proof.capUsd !== budgetUsd ||
    proof.maxItems !== 2 ||
    !Number.isSafeInteger(proof.pending) ||
    proof.pending < 0 ||
    !['foreground', 'background', 'retry', 'secondary'].every((scope) =>
      proof.covers.includes(scope),
    )
  )
    throw new Error('Hard guard cannot prove complete pre-call coverage');
  const manifest = await verifyManifest(config.corpusDir);
  const clients = clientsFor(config);
  await mkdir(out, { recursive: true, mode: 0o700 });
  const lockPath = resolve(out, 'runner.lock');
  const lock = await acquireLock(lockPath);
  const journal = new Journal(
    resolve(out, 'journal.sqlite'),
    sha256(JSON.stringify({ config, limit, budgetUsd })),
  );
  try {
    for (const id of selected.slice(0, limit)) {
      const c = corpus.cases.find((c) => c.id === id)!;
      const target = config.cases[id]!;
      const next = nextAttempt({ attempts: journal.list() }, id, limit);
      const attempt = next.attempt as Attempt;
      if (attempt.phase === 'privacy-failed')
        throw new Error('Prior privacy failure stops this campaign');
      if (attempt.phase === 'settled') continue;
      if (!next.resume) {
        if (proof.pending) throw new Error('External campaign has unsettled reservations');
        await preflight(clients, target, config.accounts);
        // This checkpoint also counts an attempt if the process dies during reservation.
        journal.put(attempt);
        await writeArtifact(out, config, journal);
        attempt.reservation = (await guard.reserve(attempt.submissionId)).receiptId;
        if (!attempt.reservation) throw new Error('Missing hard guard reservation receipt');
        attempt.phase = 'reserved';
        journal.put(attempt);
        const item = manifest.items.find((i) => i.id === id)!;
        const bytes = await readBytes(config.corpusDir, item.file);
        if (c.format === 'email') {
          if (!target.mailbox) throw new Error('No disposable mailbox supplied');
          attempt.mailboxUid = await appendEmail(target.mailbox, c, bytes);
          journal.put(attempt);
        }
        attempt.phase = 'submitting';
        journal.put(attempt);
        const posted = await submitNotice(clients.helper, target, c, bytes, attempt.submissionId);
        Object.assign(attempt, posted, { phase: 'submitted' });
        journal.put(attempt);
      } else {
        // Never replay a POST after a lost acknowledgement. The external guard must resolve it.
        const reconciled = await guard.reconcile(attempt.submissionId);
        attempt.reservation ??= reconciled.receiptId;
        if (!attempt.threadId && reconciled.submission)
          Object.assign(attempt, reconciled.submission);
        if (!attempt.threadId || !attempt.jobId)
          throw new Error('Pending submission requires reconciliation; no repost performed');
      }
      if (!attempt.threadId || !attempt.jobId) throw new Error('Missing submission evidence');
      const observation =
        attempt.observation ??
        (await collect(
          clients,
          target,
          config.accounts as Accounts,
          { threadId: attempt.threadId, jobId: attempt.jobId },
          c,
          {
            cursor: attempt.cursor,
            surfaces: attempt.helperSurfaces,
            checkpoint: async (cursor, surfaces) => {
              attempt.cursor = cursor;
              attempt.helperSurfaces = surfaces;
              journal.put(attempt);
            },
          },
        ));
      observation.submissionId = attempt.submissionId;
      observation.guardReceipt = attempt.reservation;
      attempt.observation = observation;
      attempt.phase = 'settling';
      journal.put(attempt);
      await writeArtifact(out, config, journal);
      let settled = false;
      const expiresAt = Date.now() + 30_000;
      do {
        if (!target.ledgerFile) throw new Error('No scoped ledger export supplied');
        const raw = JSON.parse(await readFile(target.ledgerFile, 'utf8')) as Ledger;
        const receipt = await guard.reconcile(attempt.submissionId);
        if (receipt.settled && raw.settled && raw.pending === 0) {
          const ledger = validateLedger(raw, {
            targetId: config.targetId,
            roomId: target.roomId,
            submissionId: attempt.submissionId,
            jobId: attempt.jobId,
          });
          observation.usage = ledger.usage;
          observation.jobIds = ledger.jobIds;
          observation.settled = true;
          requireSettlement(observation, config.requireNemotron);
          const total = ledger.usage.reduce((sum, u) => sum + u.costUsd!, 0);
          if (
            receipt.receiptId !== attempt.reservation ||
            receipt.costUsd === null ||
            !Number.isFinite(receipt.costUsd) ||
            receipt.costUsd < total ||
            receipt.costUsd > budgetUsd
          )
            throw new Error('Hard guard cost evidence incomplete or over cap');
          settled = true;
          break;
        }
        await Bun.sleep(250);
      } while (Date.now() < expiresAt);
      if (!settled) throw new Error('Bounded cost settlement timed out');
      journal.put(attempt);
      const allCosts = report(
        corpus.cases,
        journal
          .list()
          .map((a) => a.observation ?? emptyObservation(a.id, config.accounts.helper.id, a.phase)),
      ).costs;
      if (allCosts.totalUsd === null || allCosts.totalUsd > budgetUsd)
        throw new Error('Campaign cost unknown or exceeds cap');
      attempt.phase = 'settled';
      journal.put(attempt);
      await writeArtifact(out, config, journal);
      const grade = report(corpus.cases, [observation]);
      if (!grade.rows[0]?.components.noCanaryLeak || !grade.rows[0]?.components.outsiderDenied) {
        attempt.phase = 'privacy-failed';
        journal.put(attempt);
        throw new Error('Privacy check failed; remaining items stopped');
      }
    }
    await writeFile(
      resolve(out, 'report.json'),
      JSON.stringify(
        report(
          corpus.cases,
          journal
            .list()
            .map(
              (a) => a.observation ?? emptyObservation(a.id, config.accounts.helper.id, a.phase),
            ),
        ),
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await writeFile(
      resolve(out, 'report.md'),
      renderReport(
        report(
          corpus.cases,
          journal
            .list()
            .map(
              (a) => a.observation ?? emptyObservation(a.id, config.accounts.helper.id, a.phase),
            ),
        ),
      ),
      { mode: 0o600 },
    );
  } finally {
    await writeArtifact(out, config, journal);
    journal.close();
    await lock.close();
    await import('node:fs/promises').then((fs) => fs.unlink(lockPath));
  }
}

/** Offline commands never load the guard, HTTP client sessions, IMAP or a provider. */
export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    strict: true,
    options: Object.fromEntries(
      ['seed', 'out', 'corpus', 'config', 'limit', 'budget-usd', 'in'].map((name) => [
        name,
        { type: 'string' as const },
      ]),
    ),
  });
  const required = (name: string) => {
    const value = values[name];
    if (!value) throw new Error(`Missing --${name}`);
    return value as string;
  };
  if (command === 'generate') {
    const result = await generate(required('out'), Number(values.seed ?? 20261029));
    console.log(JSON.stringify({ corpusHash: result.corpusHash, count: result.items.length }));
    return;
  }
  if (command === 'dry-run') {
    const manifest = await verifyManifest(required('corpus'));
    console.log(
      JSON.stringify({
        mode: 'offline',
        corpusHash: manifest.corpusHash,
        count: manifest.items.length,
      }),
    );
    return;
  }
  if (command === 'regrade') {
    const artifact = JSON.parse(await readFile(required('in'), 'utf8')) as {
      version: number;
      corpusHash: string;
      observations: Observation[];
    };
    if (
      artifact.version !== 1 ||
      artifact.corpusHash !== corpusHash() ||
      !Array.isArray(artifact.observations)
    )
      throw new Error('Invalid recorded corpus');
    await mkdir(required('out'), { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(required('out'), 'report.json'),
      `${JSON.stringify(report(corpus.cases, artifact.observations), null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    await writeFile(
      resolve(required('out'), 'report.md'),
      renderReport(report(corpus.cases, artifact.observations)),
      { flag: 'wx', mode: 0o600 },
    );
    return;
  }
  if (command === 'run') {
    const config = JSON.parse(await readFile(required('config'), 'utf8')) as Config;
    const guard = await loadGuard(config);
    return await runCampaign(
      config,
      required('out'),
      Number(required('limit')),
      Number(required('budget-usd')),
      guard,
    );
  }
  throw new Error('Choose generate, dry-run, run or regrade');
}
if (import.meta.main)
  main().catch(() => {
    // Error objects from connectors or supplied adapters may carry credentials.
    console.error('Mail safety command failed; inspect private checkpoints and configuration.');
    process.exitCode = 1;
  });
