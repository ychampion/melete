/**
 * Bring one provider's sandboxes and the session table back into agreement.
 *
 * Two directions, each decided only on an authoritative answer:
 *
 * - A session whose sandbox the provider says is gone is marked `lost`. A
 *   provider that does not answer proves nothing, so its sessions are left
 *   as they are.
 * - A sandbox carrying this installation's owner and project labels that no
 *   live session owns is destroyed. A sandbox without those labels belongs to
 *   someone else — another installation sharing the account, or a person — and
 *   is never touched.
 *
 * A session still being opened owns its sandbox by session label until its
 * lease runs out, so reconciling while a sandbox is being created does not
 * destroy it. A workspace suspended as a snapshot owns no sandbox at all: its
 * sandbox was stopped when it was suspended, so it is not asked about, and a
 * sandbox still carrying its label is an orphan.
 */
import type { Sql } from 'postgres';
import { markSessionLost, PENDING_SANDBOX } from './sessions.ts';
import type { SandboxProvider } from './types.ts';

export type ReconcileReport = { destroyed: string[]; lost: string[] };

const ULID = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** How far before the table was read a new session is still presumed to be opening. */
const OPENING_MARGIN_MS = 10_000;

/** The millisecond a session id was minted, from its ULID; null for anything else. */
export function sessionMintedAt(id: string): number | null {
  const match = /^sbx_([0-9A-HJKMNP-TV-Z]{26})$/.exec(id);
  if (!match?.[1]) return null;
  let time = 0;
  for (const char of match[1].slice(0, 10)) time = time * 32 + ULID.indexOf(char);
  return time;
}

export async function reconcileSandboxes(options: {
  sql: Sql;
  provider: SandboxProvider;
  project: string;
  /** Only this connection's sessions, since its key is the account they live in. */
  connectionId?: string;
  signal: AbortSignal;
}): Promise<ReconcileReport> {
  const { sql, provider, project, signal } = options;
  const snapshot = Date.now();
  const rows = await sql<
    {
      id: string;
      provider_sandbox_id: string;
      status: string;
      persistence: string;
      leased: boolean;
    }[]
  >`select id, provider_sandbox_id, status, persistence, lease_expires_at > now() as leased
    from sandbox_session
    where adapter = ${provider.capabilities.adapter}
      and status in ('opening', 'ready', 'paused', 'closing')
      and (${options.connectionId ?? null}::text is null or connection_id = ${options.connectionId ?? null})`;
  const live = new Set<string>();
  const lost: string[] = [];
  for (const row of rows) {
    const pending = row.provider_sandbox_id.startsWith(PENDING_SANDBOX);
    if (row.status === 'opening') {
      if (row.leased) {
        live.add(row.id);
        if (!pending) live.add(row.provider_sandbox_id);
      }
      continue;
    }
    if (row.status === 'closing' || pending) continue;
    if (row.status === 'paused' && row.persistence === 'snapshot') continue;
    let state: 'running' | 'paused' | 'gone';
    try {
      state = await provider.inspect(
        { providerSandboxId: row.provider_sandbox_id, imageDigest: null, region: null },
        signal,
      );
    } catch {
      // No answer is not an answer; the session keeps its sandbox.
      live.add(row.provider_sandbox_id);
      continue;
    }
    if (state === 'gone') {
      if (
        await markSessionLost(
          sql,
          row.id,
          `the ${provider.capabilities.adapter} provider no longer has this sandbox`,
          row.status as 'ready' | 'paused',
        )
      )
        lost.push(row.id);
      continue;
    }
    live.add(row.provider_sandbox_id);
  }
  const destroyed = await provider.reconcile(
    project,
    new LiveSandboxes(live, snapshot - OPENING_MARGIN_MS),
    signal,
  );
  return { destroyed, lost };
}

/**
 * The identifiers a reconciliation keeps. A session minted after the table was
 * read has a row the snapshot missed and may be creating its sandbox right now,
 * so it counts as live too.
 */
class LiveSandboxes implements ReadonlySet<string> {
  constructor(
    private readonly known: Set<string>,
    private readonly mintedSince: number,
  ) {}
  has(id: string): boolean {
    const minted = sessionMintedAt(id);
    return this.known.has(id) || (minted !== null && minted >= this.mintedSince);
  }
  get size() {
    return this.known.size;
  }
  forEach(each: (value: string, key: string, set: ReadonlySet<string>) => void): void {
    for (const id of this.known) each(id, id, this);
  }
  entries() {
    return this.known.entries();
  }
  keys() {
    return this.known.keys();
  }
  values() {
    return this.known.values();
  }
  [Symbol.iterator]() {
    return this.known[Symbol.iterator]();
  }
}
