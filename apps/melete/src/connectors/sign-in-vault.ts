/**
 * Saved sign-ins: the vault Melete's browser signs in from. A person saves a
 * site, a username, a password and, when the site asks for one, the secret its
 * one-time codes come from. The password and code secret are one sealed secret
 * (connectors/secrets.ts), bound to the sign-in's id, its person, its site and
 * its username, so a sealed value moved to another row, person or site does not
 * open. Each row also names the key it was sealed under, so a changed key is
 * told apart from a damaged record and neither ever yields plaintext.
 *
 * Nothing here returns a password or code secret to a caller outside this file
 * except `withCredential`, whose callback is the browser's fill and nothing else.
 */
import {
  ID_PREFIXES,
  PASSWORD_MASK,
  type SavedSignIn,
  type SavedSignInCheck,
  type SavedSignInPolicy,
  type SignInOutcome,
} from '@melete/contracts';
import type { Sql } from 'postgres';
import { type Query, recordId } from '../broker/records.ts';
import { PostgresSecretRepository, type SealedSecretStore } from './secrets.ts';
import {
  currentCode,
  parseTotpInput,
  type SealedTotp,
  sealableTotp,
  type TotpConfig,
  TotpInvalid,
  totpFromSealed,
} from './totp.ts';

export type VaultFaultCode =
  | 'not_found'
  | 'invalid_site'
  | 'insecure_site'
  | 'invalid_code_secret'
  | 'duplicate'
  | 'no_code'
  | 'key_missing'
  | 'key_changed'
  | 'unreadable'
  | 'changed';

/** Why the vault refused. Its words are for a person and never carry what was sealed. */
export class VaultFault extends Error {
  constructor(
    readonly code: VaultFaultCode,
    message: string,
  ) {
    super(message);
    this.name = 'VaultFault';
  }
}

const FAULT_WORDS: Record<VaultFaultCode, string> = {
  not_found: 'There is no such saved sign-in of yours here.',
  invalid_site: 'That doesn’t look like a website address. Try something like example.com.',
  insecure_site: 'Saved sign-ins are only used on secure (https) sites.',
  invalid_code_secret: 'The code secret could not be read.',
  duplicate: 'A sign-in for this site with that username is already saved.',
  no_code: 'This sign-in has no code secret saved.',
  key_missing:
    'This installation has no key to keep sign-ins with. The person who runs Melete needs to set MELETE_MASTER_KEY.',
  key_changed:
    'This sign-in was saved under a different installation key, so it can’t be opened. Enter its password again to save it under the current key.',
  unreadable:
    'This sign-in can’t be opened: what was saved has been changed or damaged. Delete it and save it again.',
  changed: 'This sign-in changed while you were saving. Look at it again and retry.',
};

const fault = (code: VaultFaultCode, detail?: string) =>
  new VaultFault(code, detail ?? FAULT_WORDS[code]);

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The exact origin a sign-in is for, from what a person types: `example.com`,
 * `https://example.com/login?next=/`, `HTTPS://Example.com:443`. Only https is
 * accepted; plain http only for this machine's own address, and only where a
 * test allows it. An address carrying a username or password is refused.
 */
export function siteOrigin(input: string, options: { allowLoopbackHttp?: boolean } = {}): string {
  const text = input.trim();
  if (!text || text.length > 2048 || /\s/.test(text)) throw fault('invalid_site');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw fault('invalid_site');
  }
  if (url.username || url.password) throw fault('invalid_site');
  const host = url.hostname.toLowerCase();
  if (!host || (!host.includes('.') && !LOOPBACK.has(host) && !host.startsWith('[')))
    throw fault('invalid_site');
  if (url.protocol === 'http:') {
    if (options.allowLoopbackHttp && LOOPBACK.has(host)) return url.origin.toLowerCase();
    throw fault('insecure_site');
  }
  if (url.protocol !== 'https:') throw fault('insecure_site');
  return url.origin.toLowerCase();
}

/** The host of an origin, as a person reads it. */
export function siteOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/**
 * A username as the agent and the chat may show it: its first character and
 * no more, and for an email address the domain hidden too. `jane@example.com`
 * reads `j***@…`; `jane` reads `j***`.
 */
export function maskUsername(username: string): string {
  const first = Array.from(username.trim())[0] ?? '';
  if (!first) return '***';
  return username.includes('@') ? `${first}***@…` : `${first}***`;
}

/** One saved sign-in's row: what lists it. Never the password. */
export type VaultRecord = {
  id: string;
  spaceId: string;
  principalId: string;
  origin: string;
  label: string;
  username: string;
  secretRef: string;
  keyId: string;
  hasCode: boolean;
  policy: SavedSignInPolicy;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
  lastOutcome: SignInOutcome | null;
};

/** What the browser's fill is handed for one sign-in, inside `withCredential` only. */
export type SignInCredential = {
  username: string;
  password: string;
  totp: TotpConfig | null;
};

/** What is sealed: the secrets, and the identity they belong to. */
type SealedSignIn = {
  v: 1;
  sign_in: string;
  principal: string;
  origin: string;
  username: string;
  password: string;
  totp: SealedTotp | null;
};

type Row = {
  id: string;
  space_id: string;
  principal_id: string;
  origin: string;
  label: string;
  username: string;
  secret_ref: string;
  key_id: string;
  has_code: boolean;
  policy: string;
  created_at: Date | string;
  updated_at: Date | string;
  last_used_at: Date | string | null;
  last_outcome: string | null;
};

const OUTCOMES = new Set<string>([
  'signed_in',
  'needs_code',
  'needs_person',
  'form_not_found',
  'not_accepted',
  'wrong_site',
  'failed',
]);

function recordOf(row: Row): VaultRecord {
  return {
    id: row.id,
    spaceId: row.space_id,
    principalId: row.principal_id,
    origin: row.origin,
    label: row.label,
    username: row.username,
    secretRef: row.secret_ref,
    keyId: row.key_id,
    hasCode: row.has_code,
    policy: row.policy === 'ask_first' ? 'ask_first' : 'whenever_needed',
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at),
    lastOutcome:
      row.last_outcome && OUTCOMES.has(row.last_outcome)
        ? (row.last_outcome as SignInOutcome)
        : null,
  };
}

/** A saved sign-in as its person sees it in a list: the password is always the mask. */
export function publicSignIn(record: VaultRecord): SavedSignIn {
  return {
    id: record.id,
    origin: record.origin,
    site: siteOf(record.origin),
    label: record.label,
    username: record.username,
    password: PASSWORD_MASK,
    has_code: record.hasCode,
    policy: record.policy,
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
    last_used_at: record.lastUsedAt?.toISOString() ?? null,
    last_outcome: record.lastOutcome,
  };
}

function codeConfig(input: string): TotpConfig {
  try {
    return parseTotpInput(input);
  } catch (error) {
    if (error instanceof TotpInvalid) throw fault('invalid_code_secret', error.reason);
    throw fault('invalid_code_secret');
  }
}

const unique = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';

export type SignInInput = {
  site: string;
  username: string;
  password: string;
  code_secret?: string;
  label?: string;
  policy?: SavedSignInPolicy;
};

export type SignInChange = {
  username?: string;
  password?: string;
  code_secret?: string | null;
  label?: string;
  policy?: SavedSignInPolicy;
};

export class SignInVault {
  constructor(
    private readonly sql: Sql,
    private readonly secrets: SealedSecretStore,
    private readonly options: { allowLoopbackHttp?: boolean; now?: () => number } = {},
  ) {}

  /** The origin a site names, under this vault's rule for http. */
  origin(site: string): string {
    return siteOrigin(site, { allowLoopbackHttp: this.options.allowLoopbackHttp });
  }

  /** Whether `origin` may be signed in to at all: https, or a loopback test site. */
  allows(origin: string): boolean {
    try {
      return this.origin(origin) === origin;
    } catch {
      return false;
    }
  }

  /** The current key's name, or a plain refusal when there is no usable key. */
  private async currentKey(): Promise<string> {
    try {
      return await this.secrets.keyId();
    } catch {
      throw fault('key_missing');
    }
  }

  async list(spaceId: string, principalId: string): Promise<SavedSignIn[]> {
    const rows = await this.sql<Row[]>`select * from saved_sign_in
      where space_id = ${spaceId} and principal_id = ${principalId}
      order by lower(label), origin, username limit 500`;
    return rows.map((row) => publicSignIn(recordOf(row)));
  }

  /** One of this person's sign-ins in this space; anyone else's reads as absent. */
  async get(spaceId: string, principalId: string, id: string, tx: Query = this.sql) {
    const [row] = await tx<Row[]>`select * from saved_sign_in
      where id = ${id} and space_id = ${spaceId} and principal_id = ${principalId}`;
    if (!row) throw fault('not_found');
    return recordOf(row);
  }

  /**
   * Whose work a job is: the person whose saved sign-ins it may use. A job
   * with no person of its own is the installation owner's.
   */
  async principalOf(spaceId: string, jobId: string, tx: Query = this.sql): Promise<string | null> {
    const [row] = await tx<{ principal: string | null }[]>`select
      coalesce(j.principal_id, (select id from owner limit 1)) as principal
      from job j where j.id = ${jobId} and j.space_id = ${spaceId}`;
    return row?.principal ?? null;
  }

  /** This person's sign-ins in this space for one origin, oldest first. */
  async forOrigin(spaceId: string, principalId: string, origin: string, tx: Query = this.sql) {
    const rows = await tx<Row[]>`select * from saved_sign_in
      where space_id = ${spaceId} and principal_id = ${principalId} and origin = ${origin}
      order by created_at, id`;
    return rows.map(recordOf);
  }

  /** The sites this person has sign-ins for here, for telling the agent what there is. */
  async sites(spaceId: string, principalId: string, tx: Query = this.sql) {
    const rows = await tx<Row[]>`select * from saved_sign_in
      where space_id = ${spaceId} and principal_id = ${principalId}
      order by origin, created_at limit 50`;
    return rows.map(recordOf);
  }

  private async seal(
    spaceId: string,
    value: Omit<SealedSignIn, 'v'>,
  ): Promise<{ ref: string; keyId: string }> {
    const keyId = await this.currentKey();
    const ref = await this.secrets
      .put(spaceId, JSON.stringify({ v: 1, ...value } satisfies SealedSignIn))
      .catch(() => {
        throw fault('key_missing');
      });
    return { ref, keyId };
  }

  async create(spaceId: string, principalId: string, input: SignInInput): Promise<SavedSignIn> {
    const origin = this.origin(input.site);
    const totp = input.code_secret ? codeConfig(input.code_secret) : null;
    const id = recordId(ID_PREFIXES.saved_sign_in);
    const label = input.label?.trim() || siteOf(origin);
    const sealed = await this.seal(spaceId, {
      sign_in: id,
      principal: principalId,
      origin,
      username: input.username,
      password: input.password,
      totp: totp ? sealableTotp(totp) : null,
    });
    try {
      const [row] = await this.sql<Row[]>`insert into saved_sign_in
        (id, space_id, principal_id, origin, label, username, secret_ref, key_id, has_code, policy)
        values (${id}, ${spaceId}, ${principalId}, ${origin}, ${label}, ${input.username},
          ${sealed.ref}, ${sealed.keyId}, ${totp !== null}, ${input.policy ?? 'whenever_needed'})
        returning *`;
      if (!row) throw fault('changed');
      return publicSignIn(recordOf(row));
    } catch (error) {
      await this.secrets.forget(sealed.ref, spaceId).catch(() => {});
      if (unique(error)) throw fault('duplicate');
      throw error;
    }
  }

  async update(
    spaceId: string,
    principalId: string,
    id: string,
    change: SignInChange,
  ): Promise<SavedSignIn> {
    const record = await this.get(spaceId, principalId, id);
    const resealing =
      change.username !== undefined ||
      change.password !== undefined ||
      change.code_secret !== undefined;
    if (!resealing) {
      const [row] = await this.sql<Row[]>`update saved_sign_in set
        label = ${change.label?.trim() || record.label},
        policy = ${change.policy ?? record.policy}, updated_at = now()
        where id = ${id} and space_id = ${spaceId} and principal_id = ${principalId}
        returning *`;
      if (!row) throw fault('not_found');
      return publicSignIn(recordOf(row));
    }
    const nextTotp =
      change.code_secret === undefined
        ? undefined
        : change.code_secret === null
          ? null
          : sealableTotp(codeConfig(change.code_secret));
    // A new password, with a new code or none, is everything there is to seal:
    // the old record need not open, so this is how a sign-in saved under an
    // earlier key is saved again under the current one.
    const whole = change.password !== undefined && (nextTotp !== undefined || !record.hasCode);
    const previous = whole
      ? null
      : await this.withCredential(record, async (credential) => ({
          password: credential.password,
          totp: credential.totp ? sealableTotp(credential.totp) : null,
        }));
    const username = change.username ?? record.username;
    const totp = nextTotp !== undefined ? nextTotp : (previous?.totp ?? null);
    const sealed = await this.seal(spaceId, {
      sign_in: id,
      principal: principalId,
      origin: record.origin,
      username,
      password: change.password ?? previous?.password ?? '',
      totp,
    });
    let row: Row | undefined;
    try {
      [row] = await this.sql<Row[]>`update saved_sign_in set
        username = ${username}, label = ${change.label?.trim() || record.label},
        policy = ${change.policy ?? record.policy}, secret_ref = ${sealed.ref},
        key_id = ${sealed.keyId}, has_code = ${totp !== null}, updated_at = now()
        where id = ${id} and space_id = ${spaceId} and principal_id = ${principalId}
          and secret_ref = ${record.secretRef}
        returning *`;
    } catch (error) {
      await this.secrets.forget(sealed.ref, spaceId).catch(() => {});
      if (unique(error)) throw fault('duplicate');
      throw error;
    }
    if (!row) {
      await this.secrets.forget(sealed.ref, spaceId).catch(() => {});
      throw fault('changed');
    }
    await this.secrets.forget(record.secretRef, spaceId).catch(() => {});
    return publicSignIn(recordOf(row));
  }

  /** Gone for good: the row, its uses, and its sealed secret. */
  async delete(spaceId: string, principalId: string, id: string): Promise<void> {
    const [row] = await this.sql<{ secret_ref: string }[]>`delete from saved_sign_in
      where id = ${id} and space_id = ${spaceId} and principal_id = ${principalId}
      returning secret_ref`;
    if (!row) throw fault('not_found');
    await this.secrets.forget(row.secret_ref, spaceId);
  }

  /** Every sign-in a person saved, in every space, gone with its secrets. */
  forgetPerson(principalId: string): Promise<number> {
    return forgetSavedSignIns(this.sql, principalId);
  }

  /**
   * Opens a sign-in for one use. The key is checked first, so a key that has
   * changed is said so plainly; anything that does not open, or opens to
   * another sign-in, person, site or username, is refused as unreadable. The
   * callback is the only place the password exists outside the sealed box.
   */
  async withCredential<T>(
    record: VaultRecord,
    use: (credential: SignInCredential) => Promise<T>,
  ): Promise<T> {
    const key = await this.currentKey();
    if (key !== record.keyId) throw fault('key_changed');
    let opened: SealedSignIn;
    try {
      opened = await this.secrets.withSecret(record.secretRef, record.spaceId, async (value) => {
        const parsed = JSON.parse(value) as SealedSignIn;
        if (
          parsed?.v !== 1 ||
          parsed.sign_in !== record.id ||
          parsed.principal !== record.principalId ||
          parsed.origin !== record.origin ||
          parsed.username !== record.username ||
          typeof parsed.password !== 'string'
        )
          throw new Error('mismatch');
        return parsed;
      });
    } catch {
      throw fault('unreadable');
    }
    let totp: TotpConfig | null = null;
    if (opened.totp) {
      try {
        totp = totpFromSealed(opened.totp);
      } catch {
        throw fault('unreadable');
      }
    }
    if (record.hasCode !== (totp !== null)) throw fault('unreadable');
    return use({ username: opened.username, password: opened.password, totp });
  }

  /** The code a sign-in makes now, for its person to see. */
  async code(spaceId: string, principalId: string, id: string) {
    const record = await this.get(spaceId, principalId, id);
    if (!record.hasCode) throw fault('no_code');
    return this.withCredential(record, async (credential) => {
      if (!credential.totp) throw fault('no_code');
      return currentCode(credential.totp, this.options.now?.() ?? Date.now());
    });
  }

  /** Whether a sign-in is ready for the browser, checked here without reaching the site. */
  async check(spaceId: string, principalId: string, id: string): Promise<SavedSignInCheck> {
    const record = await this.get(spaceId, principalId, id);
    const checks: SavedSignInCheck['checks'] = [];
    checks.push(
      this.allows(record.origin)
        ? { name: 'site', ok: true, detail: `Used only on ${record.origin}.` }
        : { name: 'site', ok: false, detail: FAULT_WORDS.insecure_site },
    );
    try {
      await this.withCredential(record, async (credential) => {
        checks.push({
          name: 'sealed',
          ok: true,
          detail: 'It opens under this installation’s key.',
        });
        checks.push(
          credential.password.length > 0
            ? { name: 'password', ok: true, detail: 'A password is saved.' }
            : { name: 'password', ok: false, detail: 'No password is saved.' },
        );
        if (credential.totp) {
          const now = currentCode(credential.totp, this.options.now?.() ?? Date.now());
          checks.push({
            name: 'code',
            ok: true,
            detail: `It makes ${credential.totp.digits}-digit codes; this one changes in ${now.expires_in}s.`,
          });
        }
      });
    } catch (error) {
      checks.push({
        name: 'sealed',
        ok: false,
        detail: error instanceof VaultFault ? error.message : FAULT_WORDS.unreadable,
      });
    }
    return { id, ok: checks.every((check) => check.ok), checks };
  }

  /**
   * A receipt for one use: which sign-in, which site, for which work, what
   * came of it, and when. The row keeps no part of what was typed.
   */
  async recordUse(
    record: Pick<VaultRecord, 'id' | 'spaceId' | 'principalId' | 'origin'>,
    use: { jobId: string | null; actionId: string | null; outcome: SignInOutcome },
    tx: Query = this.sql,
  ): Promise<void> {
    await tx`insert into saved_sign_in_use
      (id, sign_in_id, space_id, principal_id, job_id, action_id, origin, outcome)
      values (${recordId(ID_PREFIXES.sign_in_use)}, ${record.id}, ${record.spaceId},
        ${record.principalId}, ${use.jobId}, ${use.actionId}, ${record.origin}, ${use.outcome})`;
    await tx`update saved_sign_in set last_used_at = now(), last_outcome = ${use.outcome}
      where id = ${record.id} and space_id = ${record.spaceId}`;
  }

  /** What an export carries for a person; see `exportSavedSignIns`. */
  exportFor(principalId: string) {
    return exportSavedSignIns(this.sql, principalId);
  }
}

/**
 * Every sign-in a person saved, in every space, gone with its sealed secrets:
 * for an account being deleted. Removing a sealed secret needs no key, so this
 * works even where the key is gone. Answers how many went.
 */
export async function forgetSavedSignIns(sql: Sql, principalId: string): Promise<number> {
  const rows = await sql<{ space_id: string; secret_ref: string }[]>`
    delete from saved_sign_in where principal_id = ${principalId}
    returning space_id, secret_ref`;
  const secrets = new PostgresSecretRepository(sql);
  for (const row of rows) await secrets.forget(row.secret_ref, row.space_id);
  return rows.length;
}

/**
 * What an export carries for a person: each site and username they saved, in
 * every space, how it may be used and when it was last used. Never a password
 * or code secret, which only open under this installation's key anyway.
 */
export async function exportSavedSignIns(sql: Sql, principalId: string) {
  const rows = await sql<Row[]>`select * from saved_sign_in
    where principal_id = ${principalId} order by space_id, origin, username`;
  return rows.map((row) => {
    const record = recordOf(row);
    return {
      space_id: record.spaceId,
      site: siteOf(record.origin),
      origin: record.origin,
      label: record.label,
      username: record.username,
      has_code: record.hasCode,
      policy: record.policy,
      created_at: record.createdAt.toISOString(),
      last_used_at: record.lastUsedAt?.toISOString() ?? null,
    };
  });
}
