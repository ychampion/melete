import { isIP } from 'node:net';
import type { Action, ConnectorHealth, DispatchResult, VerifyResult } from '@melete/contracts';
import {
  boundedText,
  CalendarConnector,
  calendarManifest,
  MAX_CALENDAR_BYTES,
} from './calendar.ts';
import type { SecretAccess } from './secrets.ts';
import type { Connector, ConnectorContext } from './types.ts';
import {
  pinnedWebRequest,
  publicPin,
  type ResolvedAddress,
  resolveHost,
  type WebTransport,
} from './web.ts';

export type IcsFeedConnection = {
  id: string;
  spaceId: string;
  secretRef: string;
  /** Plain HTTP to a loopback protocol fixture. Never set from a request. */
  allowInsecureLocalForTests?: boolean;
};

export type IcsFeedOptions = {
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  transport?: WebTransport;
  /** Reaches only the loopback protocol fixture. */
  fetcher?: typeof fetch;
};

/**
 * Where a feed may be read from. `pinned` is absent only for the loopback
 * fixture. `refused` is a property of the address and never changes;
 * `unresolved` is what the network said this time.
 */
export type IcsFeedTarget =
  | { usable: true; url: URL; pinned?: ResolvedAddress }
  | { usable: false; reason: 'refused' | 'unresolved' };

const LOOPBACK_HOSTS = ['127.0.0.1', '[::1]', 'localhost'];
const FEED_TIMEOUT_MS = 15_000;
const REFUSED = { usable: false, reason: 'refused' } as const;

/**
 * Decide whether a feed address may be read, and where the request goes.
 *
 * A feed is fetched by the service on a person's word, so it gets the checks
 * `web.fetch` gives an address a model supplies: HTTPS without embedded
 * credentials, and a destination that is globally routable whether it is
 * written as a literal or is what the name resolves to. The answer that was
 * checked is the one the request is pinned to. Plain HTTP reaches loopback only
 * where the service runs against a local fixture, the same exception the mail
 * and CalDAV connectors make.
 */
export async function icsFeedTarget(
  address: string,
  allowInsecureLocal: boolean,
  resolve: (hostname: string) => Promise<ResolvedAddress[]> = resolveHost,
): Promise<IcsFeedTarget> {
  if (!URL.canParse(address)) return REFUSED;
  const url = new URL(address);
  if (url.username || url.password) return REFUSED;
  if (allowInsecureLocal && url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname))
    return { usable: true, url };
  if (url.protocol !== 'https:') return REFUSED;
  const hostname = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  const family = isIP(hostname);
  let addresses: ResolvedAddress[];
  if (family) addresses = [{ address: hostname, family: family as 4 | 6 }];
  else {
    try {
      addresses = await resolve(hostname);
    } catch {
      return { usable: false, reason: 'unresolved' };
    }
    if (!addresses.length) return { usable: false, reason: 'unresolved' };
  }
  const pinned = publicPin(addresses);
  return pinned ? { usable: true, url, pinned } : REFUSED;
}

/**
 * A published calendar feed, read fresh on every listing.
 *
 * The address is the credential: a private feed address carries its own token,
 * so it lives in the sealed store and is only ever opened for the one request
 * that needs it. The owner chose it when installing the connection; nothing a
 * runtime sends can change where this connector reads from. The destination is
 * checked again on every read, redirects are refused so the address cannot be
 * forwarded somewhere else, and the feed is parsed by the same read-only
 * calendar code an imported file goes through.
 */
export class IcsFeedConnector implements Connector {
  readonly manifest = {
    ...calendarManifest,
    credentials: [],
    tools: calendarManifest.tools.filter((tool) => tool.name === 'calendar.list'),
  };

  constructor(
    private readonly config: IcsFeedConnection,
    private readonly secrets: SecretAccess,
    private readonly options: IcsFeedOptions = {},
  ) {}

  private load(signal?: AbortSignal): Promise<string> {
    return this.secrets.withSecret(this.config.secretRef, this.config.spaceId, async (address) => {
      const target = await icsFeedTarget(
        address,
        this.config.allowInsecureLocalForTests === true,
        this.options.resolve,
      );
      if (!target.usable) throw new Error('Calendar feed address is not usable');
      const timeout = AbortSignal.timeout(FEED_TIMEOUT_MS);
      const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
      if (!target.pinned) {
        const response = await (this.options.fetcher ?? fetch)(target.url, {
          headers: { accept: 'text/calendar, text/plain;q=0.5' },
          redirect: 'error',
          signal: bounded,
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('Calendar feed unavailable');
        }
        return boundedText(response);
      }
      const response = await (this.options.transport ?? pinnedWebRequest)(
        target.url,
        target.pinned,
        {
          signal: bounded,
          maxBytes: MAX_CALENDAR_BYTES,
          timeoutMs: FEED_TIMEOUT_MS,
          accept: 'text/calendar, text/plain;q=0.5',
        },
      );
      // A redirect is an answer like any other here: it is not a feed, and it is not followed.
      if (response.status < 200 || response.status > 299)
        throw new Error('Calendar feed unavailable');
      return response.body;
    });
  }

  async execute(action: Action, ctx: ConnectorContext): Promise<DispatchResult> {
    let ics: string;
    try {
      ics = await this.load(ctx.signal);
    } catch {
      // Never the transport's own message: it can contain the address.
      return { outcome: 'failed', reason: 'Calendar feed unavailable.', retryable: true };
    }
    try {
      return await new CalendarConnector(
        { id: this.config.id, spaceId: this.config.spaceId, mode: 'ics', ics },
        this.secrets,
      ).execute(action, ctx);
    } catch {
      return { outcome: 'failed', reason: 'Calendar feed is not a calendar.', retryable: false };
    }
  }

  async verify(): Promise<VerifyResult> {
    return { decision: 'unsupported', reason: 'a calendar feed is read-only' };
  }

  async health(): Promise<ConnectorHealth> {
    const checked_at = new Date().toISOString();
    try {
      const ics = await this.load();
      new CalendarConnector(
        { id: this.config.id, spaceId: this.config.spaceId, mode: 'ics', ics },
        this.secrets,
      );
      return { status: 'ok', detail: 'Calendar feed is available.', checked_at };
    } catch {
      return { status: 'failing', detail: 'Calendar feed unavailable.', checked_at };
    }
  }
}
