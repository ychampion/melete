/**
 * Signing in with Google through Composio: Composio's own verified Google app
 * asks the person for consent, and Composio keeps the tokens. Melete keeps
 * only which Composio account each connection acts for.
 *
 * Gmail, Google Calendar and Google Drive are separate toolkits at Composio,
 * each with its own connected account, so one sign-in walks through the parts
 * it connects one consent page at a time: the browser comes back after each,
 * that part is checked and connected, and the browser goes on to the next.
 *
 * The browser's return is never trusted. Each step's state is single use and
 * bound to the person who started it, the returned account must be the one
 * this step's link made, and the account is read again from Composio here:
 * it must belong to this person's Composio user, be of the toolkit asked for,
 * and be active. Its address is read through the account itself.
 */
import { randomState } from '../gateway/oauth.ts';
import { MemorySignInStore, type SignInStore } from '../ops/signin-store.ts';
import {
  CALENDAR_GRANTS,
  DOCUMENT_GRANTS,
  MAIL_READ_GRANTS,
  SignInFailure,
} from './account-sign-in.ts';
import { type ComposioClient, ComposioFault, type ComposioToolkit } from './composio.ts';

export type ManagedPart = 'mail' | 'calendar' | 'documents';

type PartSpec = {
  toolkit: ComposioToolkit;
  kind: 'gmail' | 'google_calendar' | 'google_drive';
  provider: 'imap' | 'caldav' | 'drive';
  grants: string[];
  label: (account: string) => string;
  /** Where the account's own address is read, and the field that holds it. */
  address: { endpoint: string; query?: Record<string, string>; read: (data: unknown) => unknown };
};

export const MANAGED_PARTS: Record<ManagedPart, PartSpec> = {
  mail: {
    toolkit: 'gmail',
    kind: 'gmail',
    provider: 'imap',
    // Composio's Gmail app is granted reading and sending; each send still waits for approval.
    grants: [...MAIL_READ_GRANTS, 'email.send'],
    label: (account) => `Gmail (${account})`,
    address: {
      endpoint: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      read: (data) => (data as { emailAddress?: unknown } | null)?.emailAddress,
    },
  },
  calendar: {
    toolkit: 'googlecalendar',
    kind: 'google_calendar',
    provider: 'caldav',
    grants: CALENDAR_GRANTS,
    label: (account) => `Google Calendar (${account})`,
    // The primary calendar's id is its owner's address.
    address: {
      endpoint: 'https://www.googleapis.com/calendar/v3/calendars/primary',
      read: (data) => (data as { id?: unknown } | null)?.id,
    },
  },
  documents: {
    toolkit: 'googledrive',
    kind: 'google_drive',
    provider: 'drive',
    grants: DOCUMENT_GRANTS,
    label: (account) => `Google Drive (${account})`,
    address: {
      endpoint: 'https://www.googleapis.com/drive/v3/about',
      query: { fields: 'user(emailAddress)' },
      read: (data) => (data as { user?: { emailAddress?: unknown } } | null)?.user?.emailAddress,
    },
  },
};

const ADDRESS = /^[^\s@<>"(),;:]{1,64}@[^\s@<>"(),;:/\\]{1,253}\.[^\s@<>"(),;:/\\]{1,63}$/;

export type ManagedSignInRequest = {
  provider: 'google';
  space_id?: string;
  /** Connect only Google Drive, as the step a person takes when first keeping a deadline on a file. */
  documents?: boolean;
};

/** One part a step of the sign-in connected. */
export type ManagedGrant = {
  spaceId: string;
  part: ManagedPart;
  kind: PartSpec['kind'];
  provider: PartSpec['provider'];
  toolkit: ComposioToolkit;
  account: string;
  connectedAccountId: string;
  label: string;
  scopes: string[];
};

export type ManagedSignInStatus =
  | { state: 'pending'; expires_at: string }
  | { state: 'connected'; connection_ids: string[] }
  | { state: 'failed'; error: string };

export type ManagedSignInHooks<Installed> = {
  publicUrl?: string;
  /** Left out when the operator has set no Composio key. */
  composio?: ComposioClient;
  /** The auth config each toolkit signs in with. */
  authConfig(toolkit: ComposioToolkit): Promise<string>;
  /** This person's Composio user: stable, and never shown. */
  userId(actor: string): Promise<string>;
  /** Settles authority over the space before anything else happens, and names it. */
  authorize(actor: string, spaceId?: string): Promise<string>;
  /** Connects one part; throws `SignInFailure('account_already_connected')` for a duplicate. */
  install(actor: string, grant: ManagedGrant): Promise<Installed[]>;
  connectionId(installed: Installed): string;
  /** Counts a call made through Composio for a space. */
  charge?(spaceId: string): Promise<void>;
  /**
   * Queue an account a link made to be removed at Composio from `due` on,
   * unless it is settled first: a sign-in left unfinished leaves nothing behind.
   */
  queueRemoval?(connectedAccountId: string, due: number): Promise<void>;
  /** An account a sign-in kept, or removed itself: no longer to be removed. */
  settleRemoval?(connectedAccountId: string): Promise<void>;
  now?: () => number;
  store?: SignInStore;
};

const PENDING_TTL_MS = 15 * 60_000;
const FINISHED_TTL_MS = 10 * 60_000;
/** How long after a step expires the account its link made is removed, unless kept. */
export const UNUSED_ACCOUNT_GRACE_MS = 5 * 60_000;

type Pending = {
  id: string;
  actor: string;
  spaceId: string;
  userId: string;
  parts: ManagedPart[];
  /** The part this step connects. */
  index: number;
  state: string;
  /** The account this step's link made; the browser must return with exactly this one. */
  connectedAccountId: string;
  connectionIds: string[];
  until: number;
};

export class ManagedSignIns<Installed> {
  private readonly store: SignInStore;
  private readonly kind = 'managed:google';

  constructor(private readonly hooks: ManagedSignInHooks<Installed>) {
    this.store = hooks.store ?? new MemorySignInStore();
  }

  private now(): number {
    return this.hooks.now?.() ?? Date.now();
  }

  /** Where Composio returns the browser: an https:// public address, or a localhost one. */
  redirectUri(): string | null {
    if (!this.hooks.publicUrl) return null;
    try {
      const url = new URL(this.hooks.publicUrl);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
      return `${url.origin}${url.pathname.replace(/\/+$/, '')}/api/managed-sign-ins/callback`;
    } catch {
      return null;
    }
  }

  available(): boolean {
    return Boolean(this.hooks.composio && this.redirectUri());
  }

  private client(): { composio: ComposioClient; redirectUri: string } {
    const composio = this.hooks.composio;
    const redirectUri = this.redirectUri();
    if (!composio) throw new SignInFailure('provider_not_configured');
    if (!redirectUri) throw new SignInFailure('callback_unavailable');
    return { composio, redirectUri };
  }

  /** A link for one part, with a fresh single-use state on the way back. */
  private async link(entry: Omit<Pending, 'state' | 'connectedAccountId' | 'until'>) {
    const { composio, redirectUri } = this.client();
    const part = MANAGED_PARTS[entry.parts[entry.index] ?? 'mail'];
    const state = randomState();
    const callback = new URL(redirectUri);
    callback.searchParams.set('state', state);
    let linked: Awaited<ReturnType<ComposioClient['link']>>;
    try {
      linked = await composio.link({
        authConfigId: await this.hooks.authConfig(part.toolkit),
        userId: entry.userId,
        callbackUrl: callback.href,
      });
    } catch (error) {
      if (error instanceof ComposioFault) throw new SignInFailure('provider_unreachable');
      throw error;
    }
    const until = this.now() + PENDING_TTL_MS;
    // Removed once this step has expired, unless the step keeps it first.
    await this.hooks.queueRemoval?.(linked.connectedAccountId, until + UNUSED_ACCOUNT_GRACE_MS);
    const pending: Pending = {
      ...entry,
      state,
      connectedAccountId: linked.connectedAccountId,
      until,
    };
    await this.store.put(this.kind, entry.id, pending, until);
    await this.store.put(`${this.kind}:state`, state, entry.id, until);
    return { pending, redirectUrl: linked.redirectUrl };
  }

  async start(
    actor: string,
    request: ManagedSignInRequest,
  ): Promise<{
    sign_in_id: string;
    authorize_url: string;
    expires_at: string;
    issuer: string;
    via: 'composio';
    connects: ManagedPart[];
  }> {
    const spaceId = await this.hooks.authorize(actor, request.space_id);
    this.client();
    const parts: ManagedPart[] = request.documents ? ['documents'] : ['mail', 'calendar'];
    const id = `msi_${randomState().slice(0, 24)}`;
    const { pending, redirectUrl } = await this.link({
      id,
      actor,
      spaceId,
      userId: await this.hooks.userId(actor),
      parts,
      index: 0,
      connectionIds: [],
    });
    return {
      sign_in_id: id,
      authorize_url: redirectUrl,
      expires_at: new Date(pending.until).toISOString(),
      issuer: new URL(redirectUrl).origin,
      via: 'composio',
      connects: parts,
    };
  }

  /** The address a connected account signs in as, read through the account itself. */
  private async address(spaceId: string, part: PartSpec, accountId: string): Promise<string> {
    const { composio } = this.client();
    await this.hooks.charge?.(spaceId).catch(() => {});
    let answer: Awaited<ReturnType<ComposioClient['proxy']>>;
    try {
      answer = await composio.proxy({
        connectedAccountId: accountId,
        endpoint: part.address.endpoint,
        method: 'GET',
        parameters: Object.entries(part.address.query ?? {}).map(([name, value]) => ({
          name,
          value,
          type: 'query' as const,
        })),
      });
    } catch (error) {
      if (error instanceof ComposioFault) throw new SignInFailure('provider_unreachable');
      throw error;
    }
    const address = part.address.read(answer.data);
    if (answer.status !== 200 || typeof address !== 'string' || !ADDRESS.test(address))
      throw new SignInFailure('account_unverified');
    return address.toLowerCase();
  }

  /**
   * An account this step made that is not kept: removed at Composio now, or
   * queued to be tried again until it is.
   */
  private async discard(accountId: string) {
    try {
      await this.hooks.composio?.removeAccount(accountId);
      await this.hooks.settleRemoval?.(accountId);
    } catch {
      process.stderr.write('managed sign-in: an unused account was not removed yet\n');
      await this.hooks.queueRemoval?.(accountId, this.now());
    }
  }

  /**
   * The browser's return from one step. Single use: the step is spent whatever
   * happens next. Answers with the next consent page when parts remain.
   */
  async complete(
    actor: string,
    query: URLSearchParams,
  ): Promise<{ installed: Installed[]; next: string | null }> {
    const now = this.now();
    const id = await this.store.get<string>(`${this.kind}:state`, query.get('state') ?? '', now);
    const entry = id ? await this.store.get<Pending>(this.kind, id, now) : undefined;
    if (!entry || entry.actor !== actor) throw new SignInFailure('sign_in_not_found');
    // Spent here whatever happens next; of two returns, on any instance, one takes it.
    if (!(await this.store.take<Pending>(this.kind, entry.id, now)))
      throw new SignInFailure('sign_in_not_found');
    await this.store.delete(`${this.kind}:state`, entry.state);
    const part = MANAGED_PARTS[entry.parts[entry.index] ?? 'mail'];
    let kept = false;
    let connectionIds = entry.connectionIds;
    try {
      if (query.get('status') !== 'success') throw new SignInFailure('sign_in_declined');
      // The account named on the way back must be the one this step's link made.
      if (query.get('connected_account_id') !== entry.connectedAccountId)
        throw new SignInFailure('account_mismatch');
      const { composio } = this.client();
      let account: Awaited<ReturnType<ComposioClient['account']>>;
      try {
        account = await composio.account(entry.connectedAccountId);
      } catch (error) {
        if (error instanceof ComposioFault)
          throw new SignInFailure(
            error.kind === 'account_unavailable' ? 'account_inactive' : 'provider_unreachable',
          );
        throw error;
      }
      if (account.userId !== entry.userId || account.toolkit !== part.toolkit)
        throw new SignInFailure('account_foreign');
      if (account.status !== 'ACTIVE' || account.disabled)
        throw new SignInFailure('account_inactive');
      const address = await this.address(entry.spaceId, part, account.id);
      const installed = await this.hooks.install(actor, {
        spaceId: entry.spaceId,
        part: entry.parts[entry.index] ?? 'mail',
        kind: part.kind,
        provider: part.provider,
        toolkit: part.toolkit,
        account: address,
        connectedAccountId: account.id,
        label: part.label(address),
        scopes: part.grants,
      });
      kept = true;
      await this.hooks.settleRemoval?.(account.id);
      connectionIds = [...connectionIds, ...installed.map((item) => this.hooks.connectionId(item))];
      if (entry.index + 1 < entry.parts.length) {
        const { redirectUrl } = await this.link({
          id: entry.id,
          actor: entry.actor,
          spaceId: entry.spaceId,
          userId: entry.userId,
          parts: entry.parts,
          index: entry.index + 1,
          connectionIds,
        });
        return { installed, next: redirectUrl };
      }
      await this.finish(entry.id, actor, { state: 'connected', connection_ids: connectionIds });
      return { installed, next: null };
    } catch (error) {
      if (!kept) await this.discard(entry.connectedAccountId);
      // A part connected before a later one stopped stays connected, and is said to be.
      await this.finish(
        entry.id,
        actor,
        connectionIds.length
          ? { state: 'connected', connection_ids: connectionIds }
          : {
              state: 'failed',
              error: error instanceof SignInFailure ? error.code : 'install_failed',
            },
      );
      throw error;
    }
  }

  async status(actor: string, id: string): Promise<ManagedSignInStatus | null> {
    const now = this.now();
    const entry = await this.store.get<Pending>(this.kind, id, now);
    if (entry)
      return entry.actor === actor
        ? { state: 'pending', expires_at: new Date(entry.until).toISOString() }
        : null;
    const done = await this.store.get<{ actor: string; status: ManagedSignInStatus }>(
      `${this.kind}:done`,
      id,
      now,
    );
    return done && done.actor === actor ? done.status : null;
  }

  private finish(id: string, actor: string, status: ManagedSignInStatus) {
    return this.store.put(`${this.kind}:done`, id, { actor, status }, this.now() + FINISHED_TTL_MS);
  }
}
