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
};

/** Counters one tunnel adds to while it lasts, even after its command settled. */
export type EgressHostCounters = {
  tunnels: number;
  refused: number;
  bytesUp: number;
  bytesDown: number;
};

export type EgressTokenEntry = {
  /** The computer the token works from. */
  sandbox: string;
  attribution: EgressAttribution;
  hosts: Map<string, EgressHostCounters>;
};

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

/** The tokens of commands still running, by a hash of the token. */
export class EgressTokens {
  private readonly live = new Map<string, EgressTokenEntry>();

  /** A fresh token for one command in this computer. */
  mint(sandbox: string, attribution: EgressAttribution): string {
    const token = randomBytes(24).toString('base64url');
    this.live.set(hashOf(token), { sandbox, attribution: { ...attribution }, hosts: new Map() });
    return token;
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
    return entry ? summarize(entry.hosts) : [];
  }

  /** Ends every token of a computer that was stopped, removed or given away. */
  revokeSandbox(sandbox: string): void {
    for (const [key, entry] of this.live) if (entry.sandbox === sandbox) this.live.delete(key);
  }

  get size(): number {
    return this.live.size;
  }
}

export function summarize(hosts: ReadonlyMap<string, EgressHostCounters>): EgressHostSummary[] {
  return [...hosts]
    .map(([host, each]) => ({
      host,
      tunnels: each.tunnels,
      refused: each.refused,
      bytes_up: each.bytesUp,
      bytes_down: each.bytesDown,
    }))
    .sort((a, b) => a.host.localeCompare(b.host));
}

/** What one command is given, and how it is ended. */
export type AttributedCommand = {
  /** Proxy names for the command's own environment, over the computer's. */
  env: Readonly<Record<'HTTPS_PROXY' | 'https_proxy' | 'HTTP_PROXY' | 'http_proxy', string>>;
  /** Ends the token; answers the hosts the command reached. */
  settle(): EgressHostSummary[];
};

/** A sandbox provider whose computers leave only through this service's egress guard. */
export interface CommandEgress {
  attributeCommand(handle: SandboxHandle, attribution: EgressAttribution): AttributedCommand;
}

export const hasCommandEgress = (provider: object): provider is CommandEgress =>
  typeof (provider as Partial<CommandEgress>).attributeCommand === 'function';
