/**
 * The installation's egress certificate authority.
 *
 * The relay terminates TLS only for the hosts of a connected command-line
 * account, with a leaf certificate this authority signs. The computer trusts
 * the authority's certificate, never its key: the key is generated at first
 * need, sealed with the master key for the purpose `egress-ca`, and opened only
 * in this process. The certificate's name constraints permit the adapters' DNS
 * subtrees and exclude every IP address, so a leaked key could vouch only for
 * those names; leaves last a day, are kept in memory per host, and are never
 * written to disk.
 *
 * The authority lasts two years. It is replaced when the adapters' subtrees
 * change or ninety days before it expires; a computer receives the new
 * certificate at its next start, and keeps trusting the old one until then.
 */
import { createPrivateKey, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { withinConstraint } from './adapters/types.ts';
import {
  certificateAuthority,
  derOf,
  type KeyPair,
  leafCertificate,
  newKeyPair,
  pem,
} from './x509.ts';

export const EGRESS_CA_PURPOSE = 'egress-ca';
const COMMON_NAME = 'Melete egress CA';
const DAY = 86_400_000;
export const CA_VALIDITY_MS = 730 * DAY;
export const CA_ROTATE_BEFORE_MS = 90 * DAY;
export const LEAF_VALIDITY_MS = DAY;
/** A cached leaf is replaced once less than this is left of it. */
const LEAF_RENEW_BEFORE_MS = 60 * 60_000;
/** Leaves kept in memory at once; the oldest goes first. */
const MAX_LEAVES = 256;

export type EgressCaRow = {
  id: string;
  certPem: string;
  sealedKey: string;
  nameConstraints: string[];
  notAfter: Date;
};

/**
 * Where the authority is kept. `current` runs `decide` on the current row
 * under a lock that serializes replacement, and stores what it returns.
 */
export interface EgressCaStore {
  current(decide: (row: EgressCaRow | null) => Promise<EgressCaRow | null>): Promise<EgressCaRow>;
}

/** What seals the key: the master key's box, bound to a purpose and the row's id. */
export interface EgressCaSealer {
  sealForPurpose(purpose: string, id: string, value: string): Promise<string>;
  openForPurpose(purpose: string, id: string, sealed: string): Promise<string>;
}

export function postgresEgressCaStore(sql: Sql): EgressCaStore {
  return {
    current: (decide) =>
      sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext('melete.egress_ca'))`;
        const [row] = await tx`select id, cert_pem, sealed_key, name_constraints, not_after
          from egress_ca where superseded_at is null order by created_at desc limit 1`;
        const current: EgressCaRow | null = row
          ? {
              id: String(row.id),
              certPem: String(row.cert_pem),
              sealedKey: String(row.sealed_key),
              nameConstraints: row.name_constraints as string[],
              notAfter: new Date(row.not_after as string | Date),
            }
          : null;
        const replacement = await decide(current);
        if (!replacement) {
          if (!current) throw new Error('the egress CA could not be created');
          return current;
        }
        await tx`update egress_ca set superseded_at = now() where superseded_at is null`;
        await tx`insert into egress_ca (id, cert_pem, sealed_key, name_constraints, not_after)
          values (${replacement.id}, ${replacement.certPem}, ${replacement.sealedKey},
            ${JSON.stringify(replacement.nameConstraints)}::jsonb,
            ${replacement.notAfter.toISOString()}::timestamptz)`;
        return replacement;
      }),
  };
}

/** For tests and a computer proof with no database: the same rules, in memory. */
export function memoryEgressCaStore(): EgressCaStore & { rows: EgressCaRow[] } {
  const rows: EgressCaRow[] = [];
  let chain = Promise.resolve();
  return {
    rows,
    current(decide) {
      const run = chain.then(async () => {
        const replacement = await decide(rows.at(-1) ?? null);
        if (replacement) rows.push(replacement);
        const current = rows.at(-1);
        if (!current) throw new Error('the egress CA could not be created');
        return current;
      });
      chain = run.then(
        () => {},
        () => {},
      );
      return run;
    },
  };
}

/** The constraint list as stored: lower case, no leading dot, sorted, once each. */
export const normalConstraints = (names: readonly string[]): string[] =>
  [...new Set(names.map((name) => name.toLowerCase().replace(/^\./, '')))].sort();

export type EgressLeaf = { cert: string; key: string; caId: string; notAfter: number };

export class EgressCertificateAuthority {
  private active?: { row: EgressCaRow; key: KeyPair['privateKey']; cert: Buffer };
  private loading?: Promise<NonNullable<EgressCertificateAuthority['active']>>;
  private readonly leaves = new Map<string, EgressLeaf>();
  private readonly now: () => number;
  private readonly constraints: string[];

  constructor(
    private readonly options: {
      store: EgressCaStore;
      sealer: EgressCaSealer;
      /** The DNS subtrees of every adapter this installation offers. */
      constraints: readonly string[];
      now?: () => number;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.constraints = normalConstraints(options.constraints);
    if (!this.constraints.length) throw new Error('the egress CA needs at least one name');
  }

  /** Whether a host is one this authority may ever vouch for. */
  permits(host: string): boolean {
    return this.constraints.some((constraint) => withinConstraint(host, constraint));
  }

  /** The certificate computers trust, as PEM. */
  async certificate(): Promise<{ id: string; pem: string }> {
    const active = await this.authority();
    return { id: active.row.id, pem: active.row.certPem };
  }

  /**
   * A leaf for `host`, from the cache while it has more than an hour left.
   * A host outside the constraints is refused here, before anything is signed.
   */
  async leaf(host: string): Promise<EgressLeaf> {
    const name = host.toLowerCase();
    if (!this.permits(name)) throw new Error(`the egress CA does not vouch for ${name}`);
    const active = await this.authority();
    const cached = this.leaves.get(name);
    if (
      cached &&
      cached.caId === active.row.id &&
      cached.notAfter - this.now() > LEAF_RENEW_BEFORE_MS
    )
      return cached;
    const keys = newKeyPair();
    const notBefore = new Date(this.now() - 5 * 60_000);
    const notAfter = new Date(
      Math.min(this.now() + LEAF_VALIDITY_MS, active.row.notAfter.getTime()),
    );
    const der = leafCertificate({
      host: name,
      keys,
      caCert: active.cert,
      caKey: active.key,
      caCommonName: COMMON_NAME,
      notBefore,
      notAfter,
    });
    const leaf: EgressLeaf = {
      cert: pem('CERTIFICATE', der),
      key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
      caId: active.row.id,
      notAfter: notAfter.getTime(),
    };
    this.leaves.delete(name);
    this.leaves.set(name, leaf);
    while (this.leaves.size > MAX_LEAVES) {
      const oldest = this.leaves.keys().next().value;
      if (oldest === undefined) break;
      this.leaves.delete(oldest);
    }
    return leaf;
  }

  /** The current authority, made or replaced when it is missing, near its end, or differently constrained. */
  private async authority() {
    const active = this.active;
    if (active && !this.stale(active.row)) return active;
    this.loading ??= this.load().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private stale(row: EgressCaRow): boolean {
    return (
      row.notAfter.getTime() - this.now() <= CA_ROTATE_BEFORE_MS ||
      normalConstraints(row.nameConstraints).join('\n') !== this.constraints.join('\n')
    );
  }

  private async load() {
    const row = await this.options.store.current(async (current) =>
      current && !this.stale(current) ? null : this.create(),
    );
    const key = createPrivateKey(
      await this.options.sealer.openForPurpose(EGRESS_CA_PURPOSE, row.id, row.sealedKey),
    );
    const loaded = { row, key, cert: derOf('CERTIFICATE', row.certPem) };
    this.active = loaded;
    this.leaves.clear();
    return loaded;
  }

  private async create(): Promise<EgressCaRow> {
    const keys = newKeyPair();
    const id = `eca_${randomUUID()}`;
    const notAfter = new Date(this.now() + CA_VALIDITY_MS);
    const der = certificateAuthority({
      keys,
      commonName: COMMON_NAME,
      permitted: this.constraints,
      notBefore: new Date(this.now() - 5 * 60_000),
      notAfter,
    });
    return {
      id,
      certPem: pem('CERTIFICATE', der),
      sealedKey: await this.options.sealer.sealForPurpose(
        EGRESS_CA_PURPOSE,
        id,
        keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
      ),
      nameConstraints: this.constraints,
      notAfter,
    };
  }
}
