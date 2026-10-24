/**
 * Signing in through Composio: Composio's own verified app for each service
 * asks the person for consent, and Composio keeps the tokens. Melete keeps
 * only which Composio account each connection acts for.
 *
 * Gmail, Google Calendar and Google Drive are separate toolkits at Composio,
 * each with its own connected account, so one Google sign-in walks through
 * the parts it connects one consent page at a time: the browser comes back
 * after each, that part is checked and connected, and the browser goes on to
 * the next. Any other app (Slack, Notion, GitHub, ...) is one part of its own.
 *
 * The browser's return is never trusted. Each step's state is single use and
 * bound to the person who started it, the returned account must be the one
 * this step's link made, and the account is read again from Composio here:
 * it must belong to this person's Composio user, be of the toolkit asked for,
 * and be active. A Google account's address is read through the account
 * itself, with one tool call.
 *
 * A link makes an account at Composio, so it is made only while the
 * operator's limit on connected accounts leaves room for one more.
 */
import { randomState } from '../gateway/oauth.ts';
import { MemorySignInStore, type SignInStore } from '../ops/signin-store.ts';
import { ComposioCapReached } from '../signals/managed-calls.ts';
import {
  CALENDAR_GRANTS,
  DOCUMENT_GRANTS,
  MAIL_READ_GRANTS,
  SignInFailure,
} from './account-sign-in.ts';
import { type ComposioClient, ComposioFault, TOOLKIT_SLUG } from './composio.ts';
import { appToolNames } from './composio-app.ts';
import type { ComposioRunner } from './composio-sessions.ts';

export type ManagedPart = 'mail' | 'calendar' | 'documents' | 'tools';

type PartSpec = {
  toolkit: string;
  kind: 'gmail' | 'google_calendar' | 'google_drive' | 'composio_app';
  provider: 'imap' | 'caldav' | 'drive' | 'composio';
  grants: string[];
  label: (account: string) => string;
  /** The tool that reads the account's own address, and the field that holds it. */
  address?: { tool: string; args: Record<string, unknown>; read: (data: unknown) => unknown };
};

export const MANAGED_PARTS: Record<Exclude<ManagedPart, 'tools'>, PartSpec> = {
  mail: {
    toolkit: 'gmail',
    kind: 'gmail',
    provider: 'imap',
    // Composio's Gmail app is granted reading and sending; each send still waits for approval.
    grants: [...MAIL_READ_GRANTS, 'email.send'],
    label: (account) => `Gmail (${account})`,
    address: {
      tool: 'GMAIL_GET_PROFILE',
      args: { user_id: 'me' },
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
      tool: 'GOOGLECALENDAR_GET_CALENDAR',
      args: { calendar_id: 'primary' },
      read: (data) => {
        const found = data as { calendar_data?: { id?: unknown }; id?: unknown } | null;
        return found?.calendar_data?.id ?? found?.id;
      },
    },
  },
  documents: {
    toolkit: 'googledrive',
    kind: 'google_drive',
    provider: 'drive',
    grants: DOCUMENT_GRANTS,
    label: (account) => `Google Drive (${account})`,
    address: {
      tool: 'GOOGLEDRIVE_GET_ABOUT',
      args: { fields: 'user(emailAddress)' },
      read: (data) => (data as { user?: { emailAddress?: unknown } } | null)?.user?.emailAddress,
    },
  },
};

/** The part an app connects: its three tools, named by its toolkit. */
export function appPart(toolkit: string, title: string): PartSpec {
  return {
    toolkit,
    kind: 'composio_app',
    provider: 'composio',
    grants: Object.values(appToolNames(toolkit)),
    label: () => title,
  };
}
const ADDRESS = /^[^\s@<>"(),;:]{1,64}@[^\s@<>"(),;:/\\]{1,253}\.[^\s@<>"(),;:/\\]{1,63}$/;

export type ManagedSignInRequest =
  | {
      provider: 'google';
      space_id?: string;
      /** Connect only Google Drive, as the step a person takes when first keeping a deadline on a file. */
      documents?: boolean;
    }
  | {
      provider: 'app';
      /** The app's toolkit at Composio, such as `slack`. */
      toolkit: string;
      space_id?: string;
    };

/** One part a step of the sign-in connected. */
export type ManagedGrant = {
  spaceId: string;
  part: ManagedPart;
  kind: PartSpec['kind'];
  provider: PartSpec['provider'];
  toolkit: string;
  /** An app's name, as its connection is called; left out for a Google part. */
  title?: string;
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
  authConfig(toolkit: string): Promise<string>;
  /**
   * An app's name when it may be connected here (Composio signs in to it, or
   * the operator set a config for it); null otherwise.
   */
  appTitle?(toolkit: string): Promise<string | null>;
  /** Runs the one tool call that reads a Google account's address. */
  runner?: ComposioRunner;
  /**
   * Runs `make`, which makes an account at Composio, only while the
   * operator's limit on connected accounts leaves room; throws
   * `ComposioCapReached` otherwise.
   */
  accountSlot?<T>(make: () => Promise<T>): Promise<T>;
  /** This person's Composio user: stable, and never shown. */
  userId(actor: string): Promise<string>;
  /** Settles authority over the space before anything else happens, and names it. */
  authorize(actor: string, spaceId?: string): Promise<string>;
  /** Connects one part; throws `SignInFailure('account_already_connected')` for a duplicate. */
  install(actor: string, grant: ManagedGrant): Promise<Installed[]>;
  connectionId(installed: Installed): string;
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
  /** The app the `tools` part connects. */
  app?: { toolkit: string; title: string };
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

  /** What the step at `index` connects. */
  private spec(entry: Pick<Pending, 'parts' | 'index' | 'app'>): PartSpec {
    const part = entry.parts[entry.index] ?? 'mail';
    if (part !== 'tools') return MANAGED_PARTS[part];
    if (!entry.app) throw new SignInFailure('sign_in_not_found');
    return appPart(entry.app.toolkit, entry.app.title);
  }

  /** A link for one part, with a fresh single-use state on the way back. */
  private async link(entry: Omit<Pending, 'state' | 'connectedAccountId' | 'until'>) {
    const { composio, redirectUri } = this.client();
    const part = this.spec(entry);
    const state = randomState();
    const callback = new URL(redirectUri);
    callback.searchParams.set('state', state);
    const until = this.now() + PENDING_TTL_MS;
    // A link makes an account at Composio: only while the limit leaves room,
    // and queued for removal at once, so it is counted until it is kept or gone.
    const make = async () => {
      const made = await composio.link({
        authConfigId: await this.hooks.authConfig(part.toolkit),
        userId: entry.userId,
        callbackUrl: callback.href,
      });
      // Removed once this step has expired, unless the step keeps it first.
      await this.hooks.queueRemoval?.(made.connectedAccountId, until + UNUSED_ACCOUNT_GRACE_MS);
      return made;
    };
    let linked: Awaited<ReturnType<ComposioClient['link']>>;
    try {
      linked = this.hooks.accountSlot ? await this.hooks.accountSlot(make) : await make();
    } catch (error) {
      if (error instanceof ComposioCapReached) throw new SignInFailure('accounts_limit_reached');
      if (error instanceof ComposioFault) throw new SignInFailure('provider_unreachable');
      throw error;
    }
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
    let app: { toolkit: string; title: string } | undefined;
    if (request.provider === 'app') {
      if (!TOOLKIT_SLUG.test(request.toolkit)) throw new SignInFailure('app_unavailable');
      let title: string | null = null;
      try {
        title = (await this.hooks.appTitle?.(request.toolkit)) ?? null;
      } catch (error) {
        if (error instanceof ComposioFault) throw new SignInFailure('provider_unreachable');
        throw error;
      }
      if (!title) throw new SignInFailure('app_unavailable');
      app = { toolkit: request.toolkit, title };
    }
    const parts: ManagedPart[] = app
      ? ['tools']
      : request.provider === 'google' && request.documents
        ? ['documents']
        : ['mail', 'calendar'];
    const id = `msi_${randomState().slice(0, 24)}`;
    const { pending, redirectUrl } = await this.link({
      id,
      actor,
      spaceId,
      userId: await this.hooks.userId(actor),
      parts,
      ...(app ? { app } : {}),
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

  /**
   * The address a Google account signs in as, read through the account itself
   * with one counted tool call. An app has none: its connection is named by
   * the app, one to a space.
   */
  private async address(part: PartSpec, accountId: string): Promise<string> {
    if (!part.address) return part.toolkit;
    const runner = this.hooks.runner;
    if (!runner) throw new SignInFailure('provider_not_configured');
    let answer: Awaited<ReturnType<ComposioRunner['run']>>;
    try {
      answer = await runner.run({
        connectedAccountId: accountId,
        toolkit: part.toolkit,
        tool: part.address.tool,
        args: part.address.args,
      });
    } catch (error) {
      if (error instanceof ComposioCapReached) throw new SignInFailure('calls_limit_reached');
      if (error instanceof ComposioFault) throw new SignInFailure('provider_unreachable');
      throw error;
    }
    const address = answer.ok ? part.address.read(answer.data) : null;
    if (typeof address !== 'string' || !ADDRESS.test(address))
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
    let kept = false;
    let connectionIds = entry.connectionIds;
    try {
      const part = this.spec(entry);
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
      const address = await this.address(part, account.id);
      const installed = await this.hooks.install(actor, {
        spaceId: entry.spaceId,
        part: entry.parts[entry.index] ?? 'mail',
        kind: part.kind,
        provider: part.provider,
        toolkit: part.toolkit,
        ...(entry.app ? { title: entry.app.title } : {}),
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
          ...(entry.app ? { app: entry.app } : {}),
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
