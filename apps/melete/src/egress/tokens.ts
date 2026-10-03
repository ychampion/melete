/**
 * Which command a connection out of the agent's computer belongs to.
 *
 * Every command the service runs in a networked computer gets its own token,
 * carried in that command's proxy address (`http://cmd:<token>@...`). The
 * egress guard reads it from `Proxy-Authorization` and accepts it only from the
 * computer it was minted for, and only until the command settles. A token is
 * attribution, not authority: without one, or with one that has ended, a
 * connection the guard would allow anyway is still allowed and is recorded as
 * unattributed; nothing is ever granted on the strength of a token alone.
 *
 * Inside one computer every process runs as the same user, so a process can
 * read another's environment and borrow its token. That moves attribution
 * between commands of the same computer and changes nothing else.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { ExecEnvName } from '@melete/contracts';
import type { SandboxHandle } from '../sandbox/types.ts';

/** `command` for one `terminal.run`; `process` for a background process that outlives it. */
export type EgressTokenKind = 'command' | 'process';

export type EgressAttribution = {
  kind: EgressTokenKind;
  /** The sandbox session the command ran under. */
  sessionId: string;
  jobId: string | null;
  attemptId: string | null;
  actionId: string | null;
  /**
   * When the command is killed for running out of time, in epoch milliseconds.
   * A request the relay holds for an approval is answered before then.
   */
  deadlineAt?: number;
};

/** One host a command reached, or tried to: what a receipt shows. */
export type EgressHostSummary = {
  host: string;
  /** Tunnels opened to it. */
  tunnels: number;
  /** Connections to it the guard refused. */
  refused: number;
  bytes_up: number;
  bytes_down: number;
  /** Present when a connected account was used on this host. */
  credentialed?: true;
  /** Requests on this host that only read, with the account. */
  reads?: number;
  /** Requests on this host that changed something, each through its own approval. */
  writes?: number;
};

/** Counters one tunnel adds to while it lasts, even after its command settled. */
export type EgressHostCounters = {
  tunnels: number;
  refused: number;
  bytesUp: number;
  bytesDown: number;
  credentialed?: boolean;
  reads?: number;
  writes?: number;
};

export type EgressTokenEntry = {
  /** The hash the token is kept under. */
  key: string;
  /** The computer the token works from. */
  sandbox: string;
  attribution: EgressAttribution;
  hosts: Map<string, EgressHostCounters>;
  /** Called once when the token ends: what was opened under it with an account closes. */
  ended: Set<() => void>;
};

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

/** Runs what waits for a token to end, once each; one that throws stops none of the others. */
function end(entry: EgressTokenEntry): void {
  const waiting = [...entry.ended];
  entry.ended.clear();
  for (const each of waiting) {
    try {
      each();
    } catch {
      // Closing a tunnel that is already gone is not a failure of the settle.
    }
  }
}

/** The tokens of commands still running, by a hash of the token. */
export class EgressTokens {
  private readonly live = new Map<string, EgressTokenEntry>();

  /** A fresh token for one command in this computer. */
  mint(sandbox: string, attribution: EgressAttribution): string {
    const token = randomBytes(24).toString('base64url');
    const key = hashOf(token);
    this.live.set(key, {
      key,
      sandbox,
      attribution: { ...attribution },
      hosts: new Map(),
      ended: new Set(),
    });
    return token;
  }

  /**
   * Whether this entry's token is still live. Asked again for every request a
   * credentialed tunnel carries, so a tunnel opened by a command that has
   * since settled never carries an account again.
   */
  isLive(entry: EgressTokenEntry): boolean {
    return this.live.get(entry.key) === entry;
  }

  /**
   * The command a presented token belongs to, or undefined. Looked up by its
   * hash, so the comparison does not depend on how much of a token matched.
   */
  find(presented: string): EgressTokenEntry | undefined {
    if (!presented || presented.length > 256) return undefined;
    return this.live.get(hashOf(presented));
  }

  /** Ends a token and answers what its command reached, by host. */
  settle(token: string): EgressHostSummary[] {
    const key = hashOf(token);
    const entry = this.live.get(key);
    this.live.delete(key);
    if (!entry) return [];
    end(entry);
    return summarize(entry.hosts);
  }

  /** Ends every token of a computer that was stopped, removed or given away. */
  revokeSandbox(sandbox: string): void {
    for (const [key, entry] of this.live)
      if (entry.sandbox === sandbox) {
        this.live.delete(key);
        end(entry);
      }
  }

  get size(): number {
    return this.live.size;
  }
}

/**
 * The most hosts one command's receipt names. Past them, the rest are counted
 * together on one `(other hosts)` entry, so a command that tries many names
 * leaves a receipt of bounded size.
 */
export const MAX_RECEIPT_HOSTS = 64;
export const OTHER_HOSTS = '(other hosts)';

/** The counters a connection to `host` adds to: its own, or the shared one past the cap. */
export function hostCounters(
  hosts: Map<string, EgressHostCounters>,
  host: string,
): EgressHostCounters {
  const own = hosts.get(host);
  if (own) return own;
  const named = hosts.size - (hosts.has(OTHER_HOSTS) ? 1 : 0);
  const key = named < MAX_RECEIPT_HOSTS ? host : OTHER_HOSTS;
  let counters = hosts.get(key);
  if (!counters) {
    counters = { tunnels: 0, refused: 0, bytesUp: 0, bytesDown: 0 };
    hosts.set(key, counters);
  }
  return counters;
}

export function summarize(hosts: ReadonlyMap<string, EgressHostCounters>): EgressHostSummary[] {
  return [...hosts]
    .map(([host, each]) => ({
      host,
      tunnels: each.tunnels,
      refused: each.refused,
      bytes_up: each.bytesUp,
      bytes_down: each.bytesDown,
      ...(each.credentialed
        ? { credentialed: true as const, reads: each.reads ?? 0, writes: each.writes ?? 0 }
        : {}),
    }))
    .sort((a, b) => a.host.localeCompare(b.host));
}

/** What one command is given, and how it is ended. */
export type AttributedCommand = {
  /**
   * Proxy names for the command's own environment, over the computer's; with a
   * connected command-line account, also the trust bundle's paths and the
   * account's placeholders. Never a secret.
   */
  env: Readonly<
    Record<'HTTPS_PROXY' | 'https_proxy' | 'HTTP_PROXY' | 'http_proxy', string> &
      Partial<Record<ExecEnvName, string>>
  >;
  /** Ends the token; answers the hosts the command reached. */
  settle(): EgressHostSummary[];
};

/** A sandbox provider whose computers leave only through this service's egress guard. */
export interface CommandEgress {
  attributeCommand(
    handle: SandboxHandle,
    attribution: EgressAttribution,
  ): AttributedCommand | Promise<AttributedCommand>;
}

export const hasCommandEgress = (provider: object): provider is CommandEgress =>
  typeof (provider as Partial<CommandEgress>).attributeCommand === 'function';
