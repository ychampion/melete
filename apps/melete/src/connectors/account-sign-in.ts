/**
 * Signing in once with an account provider (Google or Microsoft) to connect
 * that account's mail and calendar. The browser flow is the gateway's OAuth
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
import { type SignedInCredential, signedInCredentialFrom } from './signed-in.ts';

export type AccountProviderName = 'google' | 'microsoft';

/** What differs between providers; everything else about a sign-in is shared. */
export interface AccountProvider {
  readonly name: AccountProviderName;
  issuer(redirectUri: string): OAuthIssuer;
  /**
   * The address the tokens belong to, confirmed by the provider for this
   * client. Throws `SignInFailure('account_unverified')` otherwise.
   */
  account(tokens: OAuthTokens, clientId: string): Promise<string>;
  /** The grants each part may have, from the scopes the person granted. */
  grants(granted: string): { mail?: string[]; calendar?: string[] };
  labels(account: string): { mail: string; calendar: string };
}

export class SignInFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export type AccountSignInRequest = {
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
};

const PENDING_TTL_MS = 15 * 60_000;
const FINISHED_TTL_MS = 10 * 60_000;

export const MAIL_READ_GRANTS = ['email.search', 'email.read', 'email.draft', 'email.discard'];
export const CALENDAR_GRANTS = [
  'calendar.list',
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
  private readonly pending = new Map<string, Pending>();
  private readonly byState = new Map<string, string>();
  private readonly finished = new Map<
    string,
    { actor: string; status: AccountSignInStatus; until: number }
  >();

  constructor(
    readonly name: AccountProviderName,
    private readonly hooks: AccountSignInHooks<Installed>,
  ) {}

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

  private issuer() {
    const provider = this.hooks.provider;
    const redirectUri = this.redirectUri();
    if (!provider) throw new SignInFailure('provider_not_configured');
    if (!redirectUri) throw new SignInFailure('callback_unavailable');
    return { provider, issuer: provider.issuer(redirectUri) };
  }

  private sweep() {
    const now = this.now();
    for (const [id, entry] of this.pending)
      if (entry.until <= now) {
        this.pending.delete(id);
        this.byState.delete(entry.state);
      }
    for (const [id, entry] of this.finished) if (entry.until <= now) this.finished.delete(id);
  }

  async start(
    actor: string,
    request: AccountSignInRequest,
  ): Promise<{
    sign_in_id: string;
    authorize_url: string;
    redirect_uri: string;
    expires_at: string;
  }> {
    this.sweep();
    const spaceId = await this.hooks.authorize(actor, request.space_id);
    const { issuer } = this.issuer();
    const { verifier, challenge } = pkcePair();
    const state = randomState();
    const id = `asi_${randomState().slice(0, 24)}`;
    const until = this.now() + PENDING_TTL_MS;
    this.pending.set(id, { id, actor, spaceId, state, verifier, request, until });
    this.byState.set(state, id);
    return {
      sign_in_id: id,
      authorize_url: authorizeUrl(issuer, state, challenge),
      redirect_uri: issuer.redirectUri,
      expires_at: new Date(until).toISOString(),
    };
  }

  /** The browser's return. Single use: the sign-in is gone whatever happens next. */
  async complete(actor: string, query: URLSearchParams): Promise<Installed[]> {
    this.sweep();
    const id = this.byState.get(query.get('state') ?? '');
    const entry = id ? this.pending.get(id) : undefined;
    if (!entry || entry.actor !== actor) throw new SignInFailure('sign_in_not_found');
    this.pending.delete(entry.id);
    this.byState.delete(entry.state);
    try {
      if (query.get('error')) throw new SignInFailure('sign_in_declined');
      const code = query.get('code');
      if (!code) throw new SignInFailure('callback_invalid');
      const { provider, issuer } = this.issuer();
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
      const grants = provider.grants(tokens.scope ?? issuer.scopes);
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
      };
      if (!grant.mail && !grant.calendar) throw new SignInFailure('access_not_granted');
      const installed = await this.hooks.install(actor, grant);
      this.finished.set(entry.id, {
        actor,
        status: {
          state: 'connected',
          connection_ids: installed.map((item) => this.hooks.connectionId(item)),
        },
        until: this.now() + FINISHED_TTL_MS,
      });
      return installed;
    } catch (error) {
      this.finished.set(entry.id, {
        actor,
        status: {
          state: 'failed',
          error: error instanceof SignInFailure ? error.code : 'install_failed',
        },
        until: this.now() + FINISHED_TTL_MS,
      });
      throw error;
    }
  }

  status(actor: string, id: string): AccountSignInStatus | null {
    this.sweep();
    const entry = this.pending.get(id);
    if (entry)
      return entry.actor === actor
        ? { state: 'pending', expires_at: new Date(entry.until).toISOString() }
        : null;
    const done = this.finished.get(id);
    return done && done.actor === actor ? done.status : null;
  }
}
