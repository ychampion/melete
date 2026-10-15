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
 *   resolves and allows it, and the work is not in a public compartment;
 * - the connection serves the job whose computer asks, by the rule every other
 *   connection follows (`connectionServesJob`). In a person's own space that is
 *   all of its jobs. In a room it is an account the room's owners added for the
 *   room, and only the requests people make of the room's agent: never a
 *   member's own work there. A person's own account never reaches a room,
 *   except as below.
 *
 * A room's account may be set to each person's own (`per_member`). Then its
 * own secret is never used: a request of the room uses the account of the
 * same kind the person who asked connected in their own space, while they are
 * a person still in the room, and nobody else's. Their own account's grants
 * hold there too: one they connected for reading only makes no changes. With
 * none, the account is still terminated, every request through it is answered
 * with a plain note and nothing goes out as anyone, and the person who asked
 * is asked on their screen to connect their own: the turn then waits for them.
 *
 * Anything else gets a blind tunnel, exactly as a host with no account does.
 * The secret is opened for one request at a time and never leaves the service.
 */
import type { Sql } from 'postgres';
import { raisePersonQuestion } from '../broker/ask-person.ts';
import type { EgressAdmission } from '../broker/egress-admission.ts';
import type { SecretAccess } from '../connectors/secrets.ts';
import { agentAccess } from '../experience/access.ts';
import { connectionServesJob, jobConnectionAudience } from '../jobs/scopes.ts';
import type { AdapterSet } from './adapters/index.ts';
import {
  type CredentialAdapter,
  egressReadScope,
  egressWriteTool,
  hostCovered,
} from './adapters/types.ts';
import type { EgressCertificateAuthority } from './ca.ts';
import type { EgressAttribution } from './tokens.ts';

export type CredentialUse = {
  connectionId: string;
  adapter: CredentialAdapter;
  config: unknown;
  /** Opens the account's secret for one request. */
  withSecret<T>(use: (secret: string) => Promise<T>): Promise<T>;
  /**
   * Set when the room's account is each person's own and the person who asked
   * has none to use: every request is refused with this note, and no secret is
   * ever opened.
   */
  missing?: string;
  /**
   * Set when the account in use is the asker's own and they allowed it to
   * read only: every change is refused with this note before it is proposed.
   */
  readOnly?: string;
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

/** How the service an adapter reaches is named to a person. */
const SERVICE_NAME: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  npm: 'npm',
  aws: 'AWS',
};

const serviceOf = (adapter: string) => SERVICE_NAME[adapter] ?? 'this service';

/**
 * What a request of the room hears when its account is each person's own and
 * the person who asked has none to use. Someone who is not a person in the
 * room (a guest, someone who left, someone whose account is turned off, or
 * nobody) can never lend one. `asked` is
 * true when the person was asked on their screen to connect theirs.
 */
export function ownAccountMissing(
  adapter: string,
  asker: { name: string | null; member: boolean },
  asked = false,
): string {
  const service = serviceOf(adapter);
  if (!asker.member)
    return `This room uses each person's own ${service} account, and only a person who is a member of the room can use theirs here. Nothing was sent.`;
  const who = asker.name ?? 'the person who asked';
  const missing = `This room uses each person's own ${service} account, and ${who} has not connected one yet. Nothing was sent.`;
  return asked
    ? `${missing} ${asker.name ? `${asker.name} has` : 'They have'} been asked to connect ${service} for the agent's computer in Settings, under Connections. End this turn; once they reply, run the same command again.`
    : `${missing} Ask ${asker.name ?? 'them'} to connect ${service} for the agent's computer in Settings, under Connections, then run the same command again.`;
}

/** The question put to the person who asked, on their screen, when they have no account to use. */
export function connectOwnAccount(adapter: string, name: string | null): string {
  const service = serviceOf(adapter);
  return `${name ? `${name}, to` : 'To'} do this I need your own ${service} account, since this room uses each person's own. Connect ${service} for the agent's computer in Settings, under Connections, then reply here and I'll run it again.`;
}

/** What a change hears when the person's own account was connected for reading only. */
export function ownAccountReadOnly(adapter: string, name: string | null): string {
  const service = serviceOf(adapter);
  const who = name ?? 'The person who asked';
  return `This room uses each person's own ${service} account, and ${who} connected theirs for reading only, so it cannot make this change. Nothing was sent. To make it, ${name ?? 'they'} can allow changes on their own ${service} connection in Settings, under Connections, then run the same command again.`;
}

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
    const rows = await sql`select id, scopes, configuration, secret_ref, shared_use, per_member
      from connection
      where space_id = ${space} and provider = 'command_line' and status = 'active'
        and secret_ref is not null
      order by created_at, id`;
    const usable: Array<{
      id: string;
      scopes: string[];
      secretRef: string;
      sharedUse: string;
      perMember: boolean;
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
        sharedUse: String(row.shared_use),
        perMember: row.per_member === true,
        adapter,
        config,
      });
    }
    return usable;
  };
  /**
   * The person who asked a room's request, read from the request itself (or
   * the request a step belongs to, as `roomAuthorityOf` reads it, so the
   * account used is that of the one person who may approve its changes), with
   * their name, while they are a person still in the room whose account is not
   * turned off. Anyone else, or no one, is null.
   */
  const askerOf = async (jobId: string, room: string) => {
    const [row] = await sql`select case
          when r.audience = 'room' then r.requested_by_principal_id
          when j.audience = 'room' then j.requested_by_principal_id end as asker
      from job j left join job r on r.id = j.experience_parent_id and r.space_id = j.space_id
      where j.id = ${jobId}`;
    const asker = row?.asker ? String(row.asker) : null;
    if (!asker) return null;
    const [person] = await sql`select p.id, p.display_name from space_membership m
      join principal p on p.id = m.principal_id
      where m.space_id = ${room} and m.principal_id = ${asker} and m.revoked_at is null
        and m.role in ('owner', 'member') and p.kind = 'person' and p.disabled_at is null`;
    if (!person) return { id: null, name: null };
    return { id: asker, name: (person.display_name ?? null) as string | null };
  };
  /**
   * A person's own account of this adapter's kind that covers the host: in
   * their own space, active, and holding the read scope. Only ever theirs. A
   * personal space that names no owner is the installation owner's, as
   * `personalSpaceOf` in `rooms/handoffs.ts` reads it.
   */
  const ownAccount = async (principalId: string, adapterId: string, host: string) => {
    const spaces = await sql`select id from space where kind = 'personal'
      and coalesce(owner_principal_id, (select id from owner limit 1)) = ${principalId}
      and coalesce(audience, 'owner') = 'owner'
      and removed_at is null order by created_at, id`;
    for (const each of spaces) {
      const own = String(each.id);
      const found = (await accounts(own)).find(
        (account) =>
          account.adapter.id === adapterId &&
          account.scopes.includes(egressReadScope(account.adapter.id)) &&
          hostCovered(host, account.adapter.hosts(account.config)),
      );
      if (found) return { ...found, space: own };
    }
    return null;
  };
  /**
   * The kinds of space an account reaches: a person's own, for the owner's
   * audience, and a room, whose own accounts serve its requests. Any other
   * kind, including ones added later, gets none.
   */
  const reach = (kind: unknown, audience: unknown): 'personal' | 'room' | null =>
    kind === 'personal' && (audience ?? 'owner') === 'owner'
      ? 'personal'
      : kind === 'shared'
        ? 'room'
        : null;
  /**
   * The accounts a computer of this space may be set up for: every account in a
   * person's own space, and in a room only those the room's owners added for
   * the room. Which job may then use one is settled per request, in `find`.
   */
  const offered = async (space: string) => {
    const [row] = await sql`select kind, audience from space where id = ${space}`;
    const kind = reach(row?.kind, row?.audience);
    if (!kind) return [];
    const usable = await accounts(space);
    return kind === 'room' ? usable.filter((account) => account.sharedUse === 'room') : usable;
  };
  return {
    ca,
    async find({ space, attribution, host }) {
      if (!space || !attribution.jobId || !ca.permits(host)) return null;
      const candidates = (await offered(space)).filter(
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
        // A person's own space or a room; any kind added later gets no account.
        !reach(job.space_kind, job.audience) ||
        (job.constraints as { public_compartment?: boolean } | null)?.public_compartment === true
      )
        return null;
      // The job whose computer is asking decides which accounts serve it.
      const audience = await jobConnectionAudience(sql, attribution.jobId);
      if (!audience) return null;
      const access = await agentAccess(sql, attribution.jobId);
      if (access.paused || access.missingAgent) return null;
      const account = candidates.find(
        (each) =>
          connectionServesJob(audience, each.sharedUse) &&
          (!access.allowed || access.allowed.includes(each.id)),
      );
      if (!account) return null;
      if (account.perMember) {
        // Each person's own: the room's secret is never opened for anyone.
        const asker = audience.audience === 'room' ? await askerOf(attribution.jobId, space) : null;
        const own = asker?.id ? await ownAccount(asker.id, account.adapter.id, host) : null;
        if (!own) {
          const name = asker?.name ?? null;
          // A person in the room is asked, once per turn, to connect theirs; the turn then waits.
          const asked =
            asker?.id && attribution.attemptId
              ? await raisePersonQuestion(sql, {
                  jobId: attribution.jobId,
                  attemptId: attribution.attemptId,
                  question: connectOwnAccount(account.adapter.id, name),
                  why: 'Nothing was sent. What you ask here only ever uses your own account, never anyone else’s.',
                  // Not asked after all (the turn just ended): the note tells the agent to ask.
                }).catch(() => false)
              : false;
          return {
            connectionId: account.id,
            adapter: account.adapter,
            config: account.config,
            missing: ownAccountMissing(account.adapter.id, { name, member: !!asker?.id }, asked),
            withSecret: () => Promise.reject(new Error('No account of their own to use')),
          };
        }
        return {
          connectionId: account.id,
          adapter: own.adapter,
          config: own.config,
          withSecret: (use) => options.secrets.withSecret(own.secretRef, own.space, use),
          // Their own grants hold here too: one connected for reading makes no changes.
          ...(own.scopes.includes(egressWriteTool(own.adapter.id))
            ? {}
            : { readOnly: ownAccountReadOnly(own.adapter.id, asker?.name ?? null) }),
        };
      }
      return {
        connectionId: account.id,
        adapter: account.adapter,
        config: account.config,
        withSecret: (use) => options.secrets.withSecret(account.secretRef, space, use),
      };
    },
    async hosts(space) {
      if (!space) return [];
      return (await offered(space))
        .filter((account) => account.scopes.includes(egressReadScope(account.adapter.id)))
        .flatMap((account) => account.adapter.hosts(account.config))
        .filter((host) => ca.permits(host.replace(/^\./, '')));
    },
    async computer(space) {
      if (!space) return null;
      const usable = await offered(space);
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
