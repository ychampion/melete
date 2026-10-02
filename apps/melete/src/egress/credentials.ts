/**
 * Which connected command-line account, if any, a command may use at a host.
 *
 * A connection with provider `command_line` names its adapter and that
 * adapter's configuration, and holds the account's secret sealed like any
 * other. Its account is offered to a command only when all of these hold:
 *
 * - the connection is active, in the computer's own space, and holds the
 *   adapter's read scope;
 * - the adapter covers the host and the egress CA may vouch for it;
 * - the command's conversation may use the connection: not paused, its agent
 *   resolves and allows it, the space is the owner's own, and the work is not
 *   in a public compartment (a member's account never reaches a room).
 *
 * Anything else gets a blind tunnel, exactly as a host with no account does.
 * The secret is opened for one request at a time and never leaves the service.
 */
import type { Sql } from 'postgres';
import type { EgressAdmission } from '../broker/egress-admission.ts';
import type { SecretAccess } from '../connectors/secrets.ts';
import { agentAccess } from '../experience/access.ts';
import type { AdapterSet } from './adapters/index.ts';
import { type CredentialAdapter, egressReadScope, hostCovered } from './adapters/types.ts';
import type { EgressCertificateAuthority } from './ca.ts';
import type { EgressAttribution } from './tokens.ts';

export type CredentialUse = {
  connectionId: string;
  adapter: CredentialAdapter;
  config: unknown;
  /** Opens the account's secret for one request. */
  withSecret<T>(use: (secret: string) => Promise<T>): Promise<T>;
};

/** What a computer of a space with a connected account is given. */
export type ComputerTrust = {
  caId: string;
  caPem: string;
  /** Placeholder values for the commands' environment; never a secret. */
  placeholders: Record<string, string>;
};

/** What the egress relay asks about accounts. */
export interface EgressCredentialPort {
  readonly ca: Pick<EgressCertificateAuthority, 'leaf' | 'permits' | 'certificate'>;
  find(input: {
    space: string | null;
    attribution: EgressAttribution;
    host: string;
  }): Promise<CredentialUse | null>;
  /** The trust bundle and placeholders for a computer of this space, or null with no account. */
  computer(space: string | null): Promise<ComputerTrust | null>;
  /** The hosts of the space's usable accounts: what a computer held to connected hosts may reach. */
  hosts(space: string | null): Promise<string[]>;
  admitWrite: EgressAdmission;
}

/** The connection row's configuration: `{ kind: 'command_line', adapter, config }`. */
type Stored = { kind?: unknown; adapter?: unknown; config?: unknown };

let bound: EgressAdmission | undefined;

/**
 * Where the relay sends writes. The broker binds itself here once it runs in
 * this process; until then, and without one, writes are refused.
 */
export function bindEgressAdmission(admission: EgressAdmission): () => void {
  bound = admission;
  return () => {
    if (bound === admission) bound = undefined;
  };
}

const UNAVAILABLE: EgressAdmission = async () => ({
  kind: 'refused',
  status: 403,
  message: 'Changes from the command line cannot be approved on this installation right now.',
  actionId: null,
});

export function postgresEgressCredentials(options: {
  sql: Sql;
  secrets: SecretAccess;
  adapters: AdapterSet;
  ca: EgressCertificateAuthority;
  /** Left out, the broker bound in this process. */
  admission?: EgressAdmission;
}): EgressCredentialPort {
  const { sql, adapters, ca } = options;
  /** The space's usable accounts, oldest first, with their adapter and parsed configuration. */
  const accounts = async (space: string) => {
    const rows = await sql`select id, scopes, configuration, secret_ref from connection
      where space_id = ${space} and provider = 'command_line' and status = 'active'
        and secret_ref is not null
      order by created_at, id`;
    const usable: Array<{
      id: string;
      scopes: string[];
      secretRef: string;
      adapter: CredentialAdapter;
      config: unknown;
    }> = [];
    for (const row of rows) {
      const stored = (row.configuration ?? {}) as Stored;
      if (stored.kind !== 'command_line' || typeof stored.adapter !== 'string') continue;
      const adapter = adapters.get(stored.adapter as CredentialAdapter['id']);
      if (!adapter) continue;
      let config: unknown;
      try {
        config = adapter.parseConfig(stored.config);
      } catch {
        // A configuration this adapter cannot read selects nothing.
        continue;
      }
      usable.push({
        id: String(row.id),
        scopes: row.scopes as string[],
        secretRef: String(row.secret_ref),
        adapter,
        config,
      });
    }
    return usable;
  };
  return {
    ca,
    async find({ space, attribution, host }) {
      if (!space || !attribution.jobId || !ca.permits(host)) return null;
      const candidates = (await accounts(space)).filter(
        (account) =>
          account.scopes.includes(egressReadScope(account.adapter.id)) &&
          hostCovered(host, account.adapter.hosts(account.config)),
      );
      if (!candidates.length) return null;
      const [job] = await sql`select j.space_id, j.constraints, s.kind as space_kind,
          s.audience
        from job j join space s on s.id = j.space_id where j.id = ${attribution.jobId}`;
      if (
        !job ||
        job.space_id !== space ||
        job.space_kind === 'shared' ||
        (job.audience ?? 'owner') !== 'owner' ||
        (job.constraints as { public_compartment?: boolean } | null)?.public_compartment === true
      )
        return null;
      const access = await agentAccess(sql, attribution.jobId);
      if (access.paused || access.missingAgent) return null;
      const account = candidates.find(
        (each) => !access.allowed || access.allowed.includes(each.id),
      );
      if (!account) return null;
      return {
        connectionId: account.id,
        adapter: account.adapter,
        config: account.config,
        withSecret: (use) => options.secrets.withSecret(account.secretRef, space, use),
      };
    },
    async hosts(space) {
      if (!space) return [];
      return (await accounts(space))
        .filter((account) => account.scopes.includes(egressReadScope(account.adapter.id)))
        .flatMap((account) => account.adapter.hosts(account.config))
        .filter((host) => ca.permits(host.replace(/^\./, '')));
    },
    async computer(space) {
      if (!space) return null;
      const usable = await accounts(space);
      if (!usable.length) return null;
      const certificate = await ca.certificate();
      const placeholders: Record<string, string> = {};
      for (const account of usable)
        Object.assign(placeholders, account.adapter.placeholders(account.config as never));
      return { caId: certificate.id, caPem: certificate.pem, placeholders };
    },
    admitWrite: (input) => (options.admission ?? bound ?? UNAVAILABLE)(input),
  };
}
