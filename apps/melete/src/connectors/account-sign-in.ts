/**
 * Signing in once with an account provider (Google or Microsoft) to connect
 * that account's mail and calendar, and with Google its Drive. The browser flow is the gateway's OAuth
 * one (PKCE with S256, a single-use state) with the operator's own client and
 * a redirect back to this service. What the person granted decides what is
 * connected: a provider may let a person untick a scope on its consent screen,
 * and a mailbox without sending, or no calendar at all, is connected as exactly
 * that.
 */
import {
  authorizeUrl,
  exchangeCode,
  OAuthFailure,
  type OAuthFetch,
  type OAuthIssuer,
  type OAuthTokens,
  pkcePair,
  randomState,
} from '../gateway/oauth.ts';
import { MemorySignInStore, type SignInStore } from '../ops/signin-store.ts';
import { type SignedInCredential, signedInCredentialFrom } from './signed-in.ts';

export type AccountProviderName = 'google' | 'microsoft';

/** What differs between providers; everything else about a sign-in is shared. */
export interface AccountProvider {
  readonly name: AccountProviderName;
  /** `documents` asks only for Drive, beside what the account already granted. */
  issuer(redirectUri: string, options?: { documents?: boolean }): OAuthIssuer;
  /** Whether this provider has a Drive to ask for. */
  readonly asksForDocuments?: boolean;
  /**
   * The address the tokens belong to, confirmed by the provider for this
   * client. Throws `SignInFailure('account_unverified')` otherwise.
   */
  account(tokens: OAuthTokens, clientId: string): Promise<string>;
  /** The grants each part may have, from the scopes the person granted. */
  grants(granted: string): { mail?: string[]; calendar?: string[]; documents?: string[] };
  labels(account: string): { mail: string; calendar: string; documents?: string };
}

export class SignInFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export type AccountSignInRequest = {
  /** Ask only for Drive, beside what the account already granted. */
  documents?: boolean;
  space_id?: string;
  mail_label?: string;
  calendar_label?: string;
};

export type AccountSignInStatus =
  | { state: 'pending'; expires_at: string }
  | { state: 'connected'; connection_ids: string[] }
  | { state: 'failed'; error: string };

/** What one completed sign-in hands to installation. */
export type AccountGrant = {
  provider: AccountProviderName;
  spaceId: string;
  account: string;
  credential: SignedInCredential;
  mail?: { label: string; scopes: string[] };
  calendar?: { label: string; scopes: string[] };
  /** A Drive, read for what changes in its files. */
  documents?: { label: string; scopes: string[] };
};

export type AccountSignInHooks<Installed> = {
  publicUrl?: string;
  /** Left out when the operator has not configured this provider's client. */
  provider?: AccountProvider;
  /** Settles authority over the space before anything else happens, and names it. */
  authorize(actor: string, spaceId?: string): Promise<string>;
  install(actor: string, grant: AccountGrant): Promise<Installed[]>;
  connectionId(installed: Installed): string;
  fetcher?: OAuthFetch;
  now?: () => number;
  /**
   * Where sign-ins wait for the browser. Left out, this process's memory; the
   * service gives every instance the same Postgres store, so the browser may
   * come back to any of them.
   */
  store?: SignInStore;
};

const PENDING_TTL_MS = 15 * 60_000;
const FINISHED_TTL_MS = 10 * 60_000;

export const MAIL_READ_GRANTS = ['email.search', 'email.read', 'email.draft', 'email.discard'];
/** A Drive's one tool: a file's metadata as it is now. */
export const DOCUMENT_GRANTS = ['documents.status'];
export const CALENDAR_GRANTS = [
  'calendar.list',
  'calendar.freebusy',
  'calendar.create',
  'calendar.update',
  'calendar.delete',
];

type Pending = {
  id: string;
  actor: string;
  spaceId: string;
  state: string;
  verifier: string;
  request: AccountSignInRequest;
  until: number;
};

export class AccountSignIns<Installed> {
  private readonly store: SignInStore;
  /** Sign-ins waiting by id; the same kind with `:state` finds one by its state, `:done` a finished one. */
  private readonly kind: string;

  constructor(
    readonly name: AccountProviderName,
    private readonly hooks: AccountSignInHooks<Installed>,
  ) {
    this.store = hooks.store ?? new MemorySignInStore();
    this.kind = `account:${name}`;
  }

  private now(): number {
    return this.hooks.now?.() ?? Date.now();
  }

  /** Where the provider returns the browser: an https:// public address, or a localhost one. */
  redirectUri(): string | null {
    if (!this.hooks.publicUrl) return null;
    try {
      const url = new URL(this.hooks.publicUrl);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
      return `${url.origin}${url.pathname.replace(/\/+$/, '')}/api/oauth/${this.name}/callback`;
    } catch {
      return null;
    }
  }

  available(): boolean {
    return Boolean(this.hooks.provider && this.redirectUri());
  }

  private issuer(request: AccountSignInRequest = {}) {
    const provider = this.hooks.provider;
    const redirectUri = this.redirectUri();
    if (!provider) throw new SignInFailure('provider_not_configured');
    if (!redirectUri) throw new SignInFailure('callback_unavailable');
    if (request.documents && !provider.asksForDocuments)
      throw new SignInFailure('documents_unavailable');
    return {
      provider,
      issuer: provider.issuer(redirectUri, request.documents ? { documents: true } : {}),
    };
  }

  async start(
    actor: string,
    request: AccountSignInRequest,
  ): Promise<{
    sign_in_id: string;
    authorize_url: string;
    redirect_uri: string;
    expires_at: string;
    /** Where the person signs in: the authorization endpoint's origin. */
    issuer: string;
    /** Everything the sign-in asks for, one scope each. */
    scopes: string[];
  }> {
    const spaceId = await this.hooks.authorize(actor, request.space_id);
    const { issuer } = this.issuer(request);
    const { verifier, challenge } = pkcePair();
    const state = randomState();
    const id = `asi_${randomState().slice(0, 24)}`;
    const until = this.now() + PENDING_TTL_MS;
    const pending: Pending = { id, actor, spaceId, state, verifier, request, until };
    await this.store.put(this.kind, id, pending, until);
    await this.store.put(`${this.kind}:state`, state, id, until);
    return {
      sign_in_id: id,
      authorize_url: authorizeUrl(issuer, state, challenge),
      redirect_uri: issuer.redirectUri,
      expires_at: new Date(until).toISOString(),
      issuer: new URL(issuer.authorizeUrl).origin,
      scopes: issuer.scopes.split(/\s+/).filter(Boolean),
    };
  }

  /** The browser's return. Single use: the sign-in is gone whatever happens next. */
  async complete(actor: string, query: URLSearchParams): Promise<Installed[]> {
    const now = this.now();
    const id = await this.store.get<string>(`${this.kind}:state`, query.get('state') ?? '', now);
    const entry = id ? await this.store.get<Pending>(this.kind, id, now) : undefined;
    if (!entry || entry.actor !== actor) throw new SignInFailure('sign_in_not_found');
    // Spent here whatever happens next; of two returns, on any instance, one takes it.
    if (!(await this.store.take<Pending>(this.kind, entry.id, now)))
      throw new SignInFailure('sign_in_not_found');
    await this.store.delete(`${this.kind}:state`, entry.state);
    try {
      if (query.get('error')) throw new SignInFailure('sign_in_declined');
      const code = query.get('code');
      if (!code) throw new SignInFailure('callback_invalid');
      const { provider, issuer } = this.issuer(entry.request);
      let tokens: OAuthTokens;
      try {
        tokens = await exchangeCode(
          issuer,
          { code, verifier: entry.verifier, redirectUri: issuer.redirectUri },
          this.hooks.fetcher ?? ((request) => fetch(request)),
          this.now(),
        );
      } catch (error) {
        throw new SignInFailure(
          error instanceof OAuthFailure && error.code === 'code_exchange_refused'
            ? 'code_exchange_refused'
            : 'provider_unreachable',
        );
      }
      const account = await provider.account(tokens, issuer.clientId);
      // The Drive step adds Drive alone; any other sign-in never adds Drive.
      const granted = provider.grants(tokens.scope ?? issuer.scopes);
      const grants: { mail?: string[]; calendar?: string[]; documents?: string[] } = entry.request
        .documents
        ? { ...(granted.documents ? { documents: granted.documents } : {}) }
        : {
            ...(granted.mail ? { mail: granted.mail } : {}),
            ...(granted.calendar ? { calendar: granted.calendar } : {}),
          };
      const labels = provider.labels(account);
      const grant: AccountGrant = {
        provider: provider.name,
        spaceId: entry.spaceId,
        account,
        credential: signedInCredentialFrom(tokens, account, issuer.scopes),
        ...(grants.mail
          ? { mail: { label: entry.request.mail_label ?? labels.mail, scopes: grants.mail } }
          : {}),
        ...(grants.calendar
          ? {
              calendar: {
                label: entry.request.calendar_label ?? labels.calendar,
                scopes: grants.calendar,
              },
            }
          : {}),
        ...(grants.documents && labels.documents
          ? { documents: { label: labels.documents, scopes: grants.documents } }
          : {}),
      };
      if (!grant.mail && !grant.calendar && !grant.documents)
        throw new SignInFailure('access_not_granted');
      const installed = await this.hooks.install(actor, grant);
      await this.finish(entry.id, actor, {
        state: 'connected',
        connection_ids: installed.map((item) => this.hooks.connectionId(item)),
      });
      return installed;
    } catch (error) {
      await this.finish(entry.id, actor, {
        state: 'failed',
        error: error instanceof SignInFailure ? error.code : 'install_failed',
      });
      throw error;
    }
  }

  async status(actor: string, id: string): Promise<AccountSignInStatus | null> {
    const now = this.now();
    const entry = await this.store.get<Pending>(this.kind, id, now);
    if (entry)
      return entry.actor === actor
        ? { state: 'pending', expires_at: new Date(entry.until).toISOString() }
        : null;
    const done = await this.store.get<{ actor: string; status: AccountSignInStatus }>(
      `${this.kind}:done`,
      id,
      now,
    );
    return done && done.actor === actor ? done.status : null;
  }

  private finish(id: string, actor: string, status: AccountSignInStatus) {
    return this.store.put(`${this.kind}:done`, id, { actor, status }, this.now() + FINISHED_TTL_MS);
  }
}
