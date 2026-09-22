/**
 * Signed-in model-provider credentials. The owner signs in once for the whole
 * installation; the tokens are sealed with MELETE_MASTER_KEY and opened only
 * here, in the service, when the gateway forwards a model call. The runtime
 * cell, the model and every API response see none of them.
 *
 * A refresh runs once per provider at a time: one promise per process, and a
 * lock in the repository across processes. Issuers that rotate refresh tokens
 * treat a second use of the old one as theft, so two refreshes racing would
 * cost the owner their sign-in.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Sql } from 'postgres';
import { SealedSecretStore, type SecretRepository } from '../connectors/secrets.ts';
import {
  authorizeUrl,
  type DeviceCode,
  exchangeCode,
  OAuthFailure,
  type OAuthFetch,
  type OAuthIssuer,
  type OAuthTokens,
  pkcePair,
  pollDeviceCode,
  randomState,
  refreshTokens,
  requestDeviceCode,
  revokeToken,
} from './oauth.ts';
import { GatewayError, type SignedInCredential } from './types.ts';

export interface CredentialRow {
  provider: string;
  ownerId: string;
  secretId: string | null;
  ciphertext: string | null;
  generation: number;
  status: 'active' | 'sign_in_required';
  reason: string | null;
  account: string | null;
  expiresAt: Date | null;
  refreshedAt: Date | null;
}

export interface CredentialRepository {
  read(provider: string): Promise<CredentialRow | null>;
  /**
   * Runs `work` holding this provider's lock. The row it is given is current,
   * and `write` replaces it (or removes it, given null) inside the same lock.
   */
  locked<T>(
    provider: string,
    work: (
      row: CredentialRow | null,
      write: (next: CredentialRow | null) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T>;
}

/** An advisory lock held for one transaction serializes refreshes across processes. */
export class PostgresCredentialRepository implements CredentialRepository {
  constructor(private readonly sql: Sql) {}

  async read(provider: string): Promise<CredentialRow | null> {
    return rowFrom(
      (await this.sql`select * from provider_credential where provider = ${provider}`)[0],
    );
  }

  async locked<T>(
    provider: string,
    work: (
      row: CredentialRow | null,
      write: (next: CredentialRow | null) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    return (await this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${`provider_credential:${provider}`}))`;
      const [current] = await tx`select * from provider_credential where provider = ${provider}`;
      return work(rowFrom(current), async (next) => {
        if (!next) {
          await tx`delete from provider_credential where provider = ${provider}`;
          return;
        }
        await tx`insert into provider_credential (provider, owner_id, secret_id, ciphertext,
            generation, status, reason, account, expires_at, refreshed_at)
          values (${next.provider}, ${next.ownerId}, ${next.secretId}, ${next.ciphertext},
            ${next.generation}, ${next.status}, ${next.reason}, ${next.account},
            ${next.expiresAt?.toISOString() ?? null}, ${next.refreshedAt?.toISOString() ?? null})
          on conflict (provider) do update set owner_id = excluded.owner_id,
            secret_id = excluded.secret_id, ciphertext = excluded.ciphertext,
            generation = excluded.generation, status = excluded.status,
            reason = excluded.reason, account = excluded.account,
            expires_at = excluded.expires_at, refreshed_at = excluded.refreshed_at`;
      });
    })) as T;
  }
}

/** The client may hand a timestamptz back as a Date or as text. */
const timestampOf = (value: unknown): Date | null =>
  value === null || value === undefined ? null : new Date(value as string | Date);

function rowFrom(row: Record<string, unknown> | undefined): CredentialRow | null {
  if (!row) return null;
  return {
    provider: String(row.provider),
    ownerId: String(row.owner_id),
    secretId: (row.secret_id as string | null) ?? null,
    ciphertext: (row.ciphertext as string | null) ?? null,
    generation: Number(row.generation),
    status: row.status === 'active' ? 'active' : 'sign_in_required',
    reason: (row.reason as string | null) ?? null,
    account: (row.account as string | null) ?? null,
    expiresAt: timestampOf(row.expires_at),
    refreshedAt: timestampOf(row.refreshed_at),
  };
}

/** What the owner is shown. It never carries a token. */
export interface SignInStatus {
  provider: string;
  /** The provider's name as the person knows it, for a "Sign in with ..." button. */
  label: string;
  state: 'signed_out' | 'pending' | 'signed_in' | 'sign_in_required';
  account: string | null;
  expires_at: string | null;
  reason: string | null;
  /** What happened and what to do, in plain words, whenever the person has something to do. */
  message: string | null;
  methods: ('device' | 'browser')[];
}

/** Why a sign-in ended, told to the person. Every reason ends in the one thing to do. */
function endedMessage(label: string, reason: string | null): string {
  const again = 'Sign in again to keep using it.';
  switch (reason) {
    case 'refresh_expired':
      return `Your ${label} sign-in has expired. ${again}`;
    case 'refresh_revoked':
      return `${label} ended this sign-in, for example after a sign-out or a password change there. ${again}`;
    case 'refresh_reused':
      return `${label} ended this sign-in to keep the account safe. ${again}`;
    default:
      return `${label} asked for a new sign-in. ${again}`;
  }
}

export type SignInStart =
  | {
      sign_in_id: string;
      method: 'device';
      verification_url: string;
      user_code: string;
      interval: number;
      expires_at: string;
    }
  | {
      sign_in_id: string;
      method: 'browser';
      authorize_url: string;
      redirect_uri: string;
      expires_at: string;
    };

interface Pending {
  id: string;
  provider: string;
  ownerId: string;
  method: 'device' | 'browser';
  state: string;
  verifier: string;
  redirectUri: string;
  device?: DeviceCode;
  nextPollAt: number;
  expiresAt: number;
}

/** A token pair and the row generation that holds it. */
type Rotation = { tokens: OAuthTokens; generation: number };

/** An issuer, or the way to learn it, for each provider that takes a sign-in. */
export type IssuerSource = OAuthIssuer | (() => Promise<OAuthIssuer>);

/** A device code lives fifteen minutes at ChatGPT; a browser sign-in gets the same. */
const PENDING_TTL_MS = 15 * 60_000;
/** Refresh this long before expiry, as the Codex CLI does, or at half a shorter lifetime. */
const REFRESH_WINDOW_MS = 5 * 60_000;

const signInRequired = () => new GatewayError(503, 'provider_sign_in_required');

/**
 * Sealing binds the provider name and the generation into the box, so a
 * ciphertext copied onto another provider's row, or back over a newer one,
 * does not open.
 */
function sealer(masterKey: () => string | undefined) {
  const binding = (provider: string, generation: number) => `provider:${provider}:${generation}`;
  return {
    async seal(provider: string, generation: number, tokens: OAuthTokens) {
      let written: { id: string; ciphertext: string } | undefined;
      const one: SecretRepository = {
        put: async (id, _space, ciphertext) => {
          written = { id, ciphertext };
        },
        get: async () => null,
      };
      await new SealedSecretStore(one, masterKey).put(
        binding(provider, generation),
        JSON.stringify(tokens),
      );
      if (!written) throw new Error('Secret unavailable');
      return written;
    },
    async open(row: CredentialRow): Promise<OAuthTokens> {
      const { secretId, ciphertext } = row;
      if (!secretId || !ciphertext) throw signInRequired();
      const one: SecretRepository = {
        put: async () => {},
        get: async (id) => (id === secretId ? ciphertext : null),
      };
      return new SealedSecretStore(one, masterKey).withSecret(
        secretId,
        binding(row.provider, row.generation),
        async (value) => JSON.parse(value) as OAuthTokens,
      );
    },
  };
}

export interface ProviderSignInOptions {
  repository: CredentialRepository;
  issuers: Record<string, IssuerSource>;
  /** Names shown to the person; a provider left out is shown by its own name. */
  labels?: Record<string, string>;
  masterKey?: () => string | undefined;
  fetch?: OAuthFetch;
  now?: () => number;
  /** Service log. Lines carry a provider name and a fixed reason, never a token. */
  log?: (line: string) => void;
}

export class ProviderSignIn {
  private readonly pending = new Map<string, Pending>();
  private readonly refreshing = new Map<string, Promise<Rotation>>();
  /** Generations whose access token a provider refused; the next use refreshes first. */
  private readonly refused = new Map<string, number>();
  private readonly resolved = new Map<string, Promise<OAuthIssuer>>();
  private readonly fetcher: OAuthFetch;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly box: ReturnType<typeof sealer>;

  constructor(private readonly options: ProviderSignInOptions) {
    this.fetcher = options.fetch ?? ((request) => fetch(request));
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.box = sealer(options.masterKey ?? (() => process.env.MELETE_MASTER_KEY));
  }

  /** The providers this installation lets the owner sign in to. */
  get providers(): string[] {
    return Object.keys(this.options.issuers);
  }

  handles(provider: string): boolean {
    return Object.hasOwn(this.options.issuers, provider);
  }

  private issuer(provider: string): Promise<OAuthIssuer> {
    const source = this.options.issuers[provider];
    if (!source) throw new OAuthFailure('provider_not_signed_in_kind', false);
    if (typeof source !== 'function') return Promise.resolve(source);
    let found = this.resolved.get(provider);
    if (!found) {
      found = source().catch((error) => {
        this.resolved.delete(provider);
        throw error;
      });
      this.resolved.set(provider, found);
    }
    return found;
  }

  async status(provider: string): Promise<SignInStatus> {
    const source = this.options.issuers[provider];
    const methods: SignInStatus['methods'] =
      source && typeof source !== 'function' && source.device ? ['device', 'browser'] : ['browser'];
    const label = this.options.labels?.[provider] ?? provider;
    const row = await this.options.repository.read(provider);
    const waiting = [...this.pending.values()].some(
      (entry) => entry.provider === provider && entry.expiresAt > this.now(),
    );
    if (!row)
      return {
        provider,
        label,
        state: waiting ? 'pending' : 'signed_out',
        account: null,
        expires_at: null,
        reason: null,
        message: waiting ? `Finish signing in to ${label} to start using it.` : null,
        methods,
      };
    const active = row.status === 'active';
    return {
      provider,
      label,
      state: active ? 'signed_in' : 'sign_in_required',
      account: row.account,
      expires_at: row.expiresAt?.toISOString() ?? null,
      reason: active ? null : row.reason,
      message: active ? null : endedMessage(label, row.reason),
      methods,
    };
  }

  /** Begins a sign-in. A newer start for the same provider replaces an older one. */
  async start(
    provider: string,
    ownerId: string,
    method?: 'device' | 'browser',
  ): Promise<SignInStart> {
    const issuer = await this.issuer(provider);
    const chosen = method ?? (issuer.device ? 'device' : 'browser');
    if (chosen === 'device' && !issuer.device)
      throw new OAuthFailure('device_sign_in_unavailable', false);
    this.sweep();
    for (const [id, entry] of this.pending)
      if (entry.provider === provider) this.pending.delete(id);
    const id = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + PENDING_TTL_MS;
    const { verifier, challenge } = pkcePair();
    const state = randomState();
    if (chosen === 'device' && issuer.device) {
      const device = await requestDeviceCode(issuer, this.fetcher);
      this.pending.set(id, {
        id,
        provider,
        ownerId,
        method: 'device',
        state,
        verifier,
        redirectUri: issuer.device.redirectUri,
        device,
        nextPollAt: this.now(),
        expiresAt,
      });
      return {
        sign_in_id: id,
        method: 'device',
        verification_url: issuer.device.verificationUrl,
        user_code: device.userCode,
        interval: device.intervalSeconds,
        expires_at: new Date(expiresAt).toISOString(),
      };
    }
    this.pending.set(id, {
      id,
      provider,
      ownerId,
      method: 'browser',
      state,
      verifier,
      redirectUri: issuer.redirectUri,
      nextPollAt: 0,
      expiresAt,
    });
    return {
      sign_in_id: id,
      method: 'browser',
      authorize_url: authorizeUrl(issuer, state, challenge),
      redirect_uri: issuer.redirectUri,
      expires_at: new Date(expiresAt).toISOString(),
    };
  }

  /**
   * Finishes a sign-in. A browser sign-in is given the address the issuer sent
   * the browser back to; a device sign-in is polled once, at most once per the
   * interval the issuer asked for, and answers `pending` until the person is
   * done at the verification page.
   */
  async complete(
    provider: string,
    ownerId: string,
    input: { sign_in_id: string; callback_url?: string },
  ): Promise<SignInStatus | { state: 'pending'; interval: number }> {
    this.sweep();
    const entry = this.pending.get(input.sign_in_id);
    if (!entry || entry.provider !== provider || entry.ownerId !== ownerId)
      throw new OAuthFailure('sign_in_not_found', false);
    const issuer = await this.issuer(provider);
    let tokens: OAuthTokens | null;
    if (entry.method === 'device' && entry.device) {
      if (this.now() < entry.nextPollAt)
        return { state: 'pending', interval: entry.device.intervalSeconds };
      entry.nextPollAt = this.now() + entry.device.intervalSeconds * 1000;
      try {
        tokens = await pollDeviceCode(issuer, entry.device, this.fetcher, this.now());
      } catch (error) {
        if (error instanceof OAuthFailure && error.permanent) this.pending.delete(entry.id);
        throw error;
      }
      if (!tokens) return { state: 'pending', interval: entry.device.intervalSeconds };
    } else {
      const code = this.callbackCode(entry, input.callback_url);
      // One use: a pasted address is spent whether or not the exchange succeeds.
      this.pending.delete(entry.id);
      tokens = await exchangeCode(
        issuer,
        { code, verifier: entry.verifier, redirectUri: entry.redirectUri },
        this.fetcher,
        this.now(),
      );
    }
    this.pending.delete(entry.id);
    await this.store(issuer, ownerId, tokens);
    this.log(`provider sign-in: ${provider} signed in`);
    return this.status(provider);
  }

  /** The code in a pasted callback address, once its address and state are the ones sent. */
  private callbackCode(entry: Pending, callback: string | undefined): string {
    let url: URL;
    try {
      url = new URL(callback ?? '');
    } catch {
      throw new OAuthFailure('callback_invalid', false);
    }
    const expected = new URL(entry.redirectUri);
    if (url.origin !== expected.origin || url.pathname !== expected.pathname)
      throw new OAuthFailure('callback_invalid', false);
    const state = Buffer.from(url.searchParams.get('state') ?? '');
    const sent = Buffer.from(entry.state);
    if (state.length !== sent.length || !timingSafeEqual(state, sent))
      throw new OAuthFailure('state_mismatch', false);
    if (url.searchParams.get('error')) throw new OAuthFailure('sign_in_declined', false);
    const code = url.searchParams.get('code');
    if (!code || code.length > 4096) throw new OAuthFailure('callback_invalid', false);
    return code;
  }

  private async store(issuer: OAuthIssuer, ownerId: string, tokens: OAuthTokens): Promise<void> {
    const replaced = await this.options.repository.locked(issuer.provider, async (row, write) => {
      const generation = (row?.generation ?? 0) + 1;
      const sealed = await this.box.seal(issuer.provider, generation, tokens);
      await write({
        provider: issuer.provider,
        ownerId,
        secretId: sealed.id,
        ciphertext: sealed.ciphertext,
        generation,
        status: 'active',
        reason: null,
        account: issuer.account?.(tokens) ?? null,
        expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt) : null,
        refreshedAt: new Date(this.now()),
      });
      return row?.ciphertext ? await this.box.open(row).catch(() => null) : null;
    });
    // A sign-in over an earlier one retires the earlier grant at the issuer.
    if (replaced) await this.revoke(issuer, replaced);
  }

  private async revoke(issuer: OAuthIssuer, tokens: OAuthTokens): Promise<void> {
    const revoked = await revokeToken(
      issuer,
      tokens.refreshToken
        ? { value: tokens.refreshToken, hint: 'refresh_token' }
        : { value: tokens.accessToken, hint: 'access_token' },
      this.fetcher,
    );
    if (!revoked && issuer.revokeUrl)
      this.log(`provider sign-in: ${issuer.provider} revocation was not confirmed`);
  }

  /** Removes the credential and asks the issuer to revoke it. */
  async signOut(provider: string): Promise<SignInStatus> {
    for (const [id, entry] of this.pending)
      if (entry.provider === provider) this.pending.delete(id);
    const issuer = await this.issuer(provider);
    const removed = await this.options.repository.locked(provider, async (row, write) => {
      await write(null);
      return row?.ciphertext ? await this.box.open(row).catch(() => null) : null;
    });
    if (removed) await this.revoke(issuer, removed);
    this.log(`provider sign-in: ${provider} signed out`);
    return this.status(provider);
  }

  /** What the gateway calls for a signed-in provider. */
  credential(provider: string): SignedInCredential {
    return {
      current: () => this.current(provider),
      rejected: (generation) => {
        this.refused.set(provider, generation);
      },
    };
  }

  private fresh(tokens: OAuthTokens): boolean {
    if (!tokens.expiresAt) return true;
    const lifetime = tokens.issuedAt
      ? tokens.expiresAt - tokens.issuedAt
      : Number.POSITIVE_INFINITY;
    return tokens.expiresAt - Math.min(REFRESH_WINDOW_MS, lifetime / 2) > this.now();
  }

  private async current(provider: string) {
    let current: Rotation;
    try {
      const row = await this.options.repository.read(provider);
      if (row?.status !== 'active') throw signInRequired();
      current = { tokens: await this.box.open(row), generation: row.generation };
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(503, 'provider_credential_unavailable');
    }
    if (!this.fresh(current.tokens) || this.refused.get(provider) === current.generation) {
      let flight = this.refreshing.get(provider);
      if (!flight) {
        flight = this.refresh(provider, current.generation).finally(() =>
          this.refreshing.delete(provider),
        );
        this.refreshing.set(provider, flight);
      }
      current = await flight;
    }
    const issuer = await this.issuer(provider);
    return {
      token: current.tokens.accessToken,
      generation: current.generation,
      headers: issuer.requestHeaders?.(current.tokens) ?? {},
    };
  }

  /**
   * Refreshes under the provider's lock. A row whose generation moved while
   * this process waited was refreshed by someone else, and is used as it is.
   */
  private refresh(provider: string, seen: number): Promise<Rotation> {
    return this.options.repository.locked(provider, async (row, write) => {
      if (row?.status !== 'active') throw signInRequired();
      const tokens = await this.box.open(row).catch(() => {
        throw new GatewayError(503, 'provider_credential_unavailable');
      });
      const kept = { tokens, generation: row.generation };
      const expired = !!tokens.expiresAt && tokens.expiresAt <= this.now();
      // Rotated by another request while this one waited for the lock.
      if (row.generation !== seen && !expired && this.refused.get(provider) !== row.generation)
        return kept;
      const issuer = await this.issuer(provider);
      const giveUp = async (reason: string) => {
        await write({
          ...row,
          secretId: null,
          ciphertext: null,
          status: 'sign_in_required',
          reason,
        });
        this.log(`provider sign-in: ${provider} needs a new sign-in (${reason})`);
        return signInRequired();
      };
      if (!tokens.refreshToken) {
        if (!expired && this.refused.get(provider) !== row.generation) return kept;
        throw await giveUp('access_expired');
      }
      let next: OAuthTokens;
      try {
        next = await refreshTokens(issuer, tokens.refreshToken, this.fetcher, this.now());
      } catch (error) {
        const failure =
          error instanceof OAuthFailure ? error : new OAuthFailure('refresh_unavailable', false);
        if (failure.permanent) throw await giveUp(failure.code);
        this.log(`provider sign-in: ${provider} refresh failed (${failure.code})`);
        // A token that has not yet expired still serves while the issuer is away.
        if (!expired) return kept;
        throw new GatewayError(503, 'provider_credential_unavailable');
      }
      const merged: OAuthTokens = {
        accessToken: next.accessToken,
        refreshToken: next.refreshToken ?? tokens.refreshToken,
        idToken: next.idToken ?? tokens.idToken,
        expiresAt: next.expiresAt,
        issuedAt: next.issuedAt,
      };
      const generation = row.generation + 1;
      const sealed = await this.box.seal(provider, generation, merged);
      await write({
        ...row,
        secretId: sealed.id,
        ciphertext: sealed.ciphertext,
        generation,
        account: issuer.account?.(merged) ?? row.account,
        expiresAt: merged.expiresAt ? new Date(merged.expiresAt) : null,
        refreshedAt: new Date(this.now()),
      });
      this.refused.delete(provider);
      return { tokens: merged, generation };
    });
  }

  private sweep() {
    for (const [id, entry] of this.pending)
      if (entry.expiresAt <= this.now()) this.pending.delete(id);
  }
}
