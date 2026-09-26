/**
 * Signing in with Google once to connect Gmail and Google Calendar. The
 * browser flow is the gateway's OAuth one (PKCE with S256, a single-use
 * state), with the operator's own Google client and a redirect back to this
 * service. What the person granted decides what is connected: Google lets a
 * person untick a scope on its consent screen, and a mailbox without sending,
 * or no calendar at all, is connected as exactly that.
 */
import {
  authorizeUrl,
  exchangeCode,
  jwtClaims,
  OAuthFailure,
  type OAuthFetch,
  type OAuthTokens,
  pkcePair,
  randomState,
} from '../gateway/oauth.ts';
import {
  GOOGLE_ENDPOINTS,
  GOOGLE_ISSUERS,
  GOOGLE_SCOPES,
  type GoogleClient,
  type GoogleCredential,
  type GoogleEndpoints,
  googleCredentialFrom,
  googleIssuer,
} from './google.ts';

export class GoogleSignInFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export type GoogleSignInRequest = {
  space_id?: string;
  mail_label?: string;
  calendar_label?: string;
};

export type GoogleSignInStatus =
  | { state: 'pending'; expires_at: string }
  | { state: 'connected'; connection_ids: string[] }
  | { state: 'failed'; error: string };

/** What one completed sign-in hands to installation. */
export type GoogleGrant = {
  spaceId: string;
  account: string;
  credential: GoogleCredential;
  mail?: { label: string; scopes: string[] };
  calendar?: { label: string; scopes: string[] };
};

export type GoogleSignInHooks<Installed> = {
  publicUrl?: string;
  google?: { client: GoogleClient; endpoints?: GoogleEndpoints };
  /** Settles authority over the space before anything else happens, and names it. */
  authorize(actor: string, spaceId?: string): Promise<string>;
  install(actor: string, grant: GoogleGrant): Promise<Installed[]>;
  connectionId(installed: Installed): string;
  fetcher?: OAuthFetch;
  now?: () => number;
};

const PENDING_TTL_MS = 15 * 60_000;
const FINISHED_TTL_MS = 10 * 60_000;

const MAIL_READ_GRANTS = ['email.search', 'email.read', 'email.draft', 'email.discard'];
const CALENDAR_GRANTS = ['calendar.list', 'calendar.create', 'calendar.update', 'calendar.delete'];

type Pending = {
  id: string;
  actor: string;
  spaceId: string;
  state: string;
  verifier: string;
  request: GoogleSignInRequest;
  until: number;
};

export class GoogleSignIns<Installed> {
  private readonly pending = new Map<string, Pending>();
  private readonly byState = new Map<string, string>();
  private readonly finished = new Map<
    string,
    { actor: string; status: GoogleSignInStatus; until: number }
  >();

  constructor(private readonly hooks: GoogleSignInHooks<Installed>) {}

  private now(): number {
    return this.hooks.now?.() ?? Date.now();
  }

  /** Where Google returns the browser: an https:// public address, or a localhost one. */
  redirectUri(): string | null {
    if (!this.hooks.publicUrl) return null;
    try {
      const url = new URL(this.hooks.publicUrl);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
      return `${url.origin}${url.pathname.replace(/\/+$/, '')}/api/oauth/google/callback`;
    } catch {
      return null;
    }
  }

  available(): boolean {
    return Boolean(this.hooks.google && this.redirectUri());
  }

  private issuer() {
    const google = this.hooks.google;
    const redirectUri = this.redirectUri();
    if (!google) throw new GoogleSignInFailure('google_not_configured');
    if (!redirectUri) throw new GoogleSignInFailure('callback_unavailable');
    return googleIssuer(google.client, redirectUri, google.endpoints ?? GOOGLE_ENDPOINTS);
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
    request: GoogleSignInRequest,
  ): Promise<{
    sign_in_id: string;
    authorize_url: string;
    redirect_uri: string;
    expires_at: string;
  }> {
    this.sweep();
    const spaceId = await this.hooks.authorize(actor, request.space_id);
    const issuer = this.issuer();
    const { verifier, challenge } = pkcePair();
    const state = randomState();
    const id = `gsi_${randomState().slice(0, 24)}`;
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
    if (!entry || entry.actor !== actor) throw new GoogleSignInFailure('sign_in_not_found');
    this.pending.delete(entry.id);
    this.byState.delete(entry.state);
    try {
      if (query.get('error')) throw new GoogleSignInFailure('sign_in_declined');
      const code = query.get('code');
      if (!code) throw new GoogleSignInFailure('callback_invalid');
      const issuer = this.issuer();
      let tokens: OAuthTokens;
      try {
        tokens = await exchangeCode(
          issuer,
          { code, verifier: entry.verifier, redirectUri: issuer.redirectUri },
          this.hooks.fetcher ?? ((request) => fetch(request)),
          this.now(),
        );
      } catch (error) {
        throw new GoogleSignInFailure(
          error instanceof OAuthFailure && error.code === 'code_exchange_refused'
            ? 'code_exchange_refused'
            : 'google_unreachable',
        );
      }
      const account = this.account(tokens, issuer.clientId);
      const granted = new Set((tokens.scope ?? issuer.scopes).split(/\s+/));
      const grant: GoogleGrant = {
        spaceId: entry.spaceId,
        account,
        credential: googleCredentialFrom(tokens, account),
        ...(granted.has(GOOGLE_SCOPES.mailRead)
          ? {
              mail: {
                label: entry.request.mail_label ?? `Gmail (${account})`,
                scopes: [
                  ...MAIL_READ_GRANTS,
                  ...(granted.has(GOOGLE_SCOPES.mailSend) ? ['email.send'] : []),
                ],
              },
            }
          : {}),
        ...(granted.has(GOOGLE_SCOPES.calendar)
          ? {
              calendar: {
                label: entry.request.calendar_label ?? `Google Calendar (${account})`,
                scopes: CALENDAR_GRANTS,
              },
            }
          : {}),
      };
      if (!grant.mail && !grant.calendar) throw new GoogleSignInFailure('access_not_granted');
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
          error: error instanceof GoogleSignInFailure ? error.code : 'install_failed',
        },
        until: this.now() + FINISHED_TTL_MS,
      });
      throw error;
    }
  }

  /**
   * The signed-in address, from the id token Google's token endpoint returned
   * over TLS: it must be for this client, from Google, and verified.
   */
  private account(tokens: OAuthTokens, clientId: string): string {
    const claims = jwtClaims(tokens.idToken);
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (
      typeof claims.email !== 'string' ||
      claims.email_verified !== true ||
      !audience.includes(clientId) ||
      !GOOGLE_ISSUERS.includes(String(claims.iss))
    )
      throw new GoogleSignInFailure('account_unverified');
    return claims.email.toLowerCase();
  }

  status(actor: string, id: string): GoogleSignInStatus | null {
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
