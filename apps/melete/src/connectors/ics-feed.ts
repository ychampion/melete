import type { Action, ConnectorHealth, DispatchResult, VerifyResult } from '@melete/contracts';
import { boundedText, CalendarConnector, calendarManifest } from './calendar.ts';
import type { SecretAccess } from './secrets.ts';
import type { Connector, ConnectorContext } from './types.ts';

export type IcsFeedConnection = {
  id: string;
  spaceId: string;
  secretRef: string;
  /** Plain HTTP to a loopback protocol fixture. Never set from a request. */
  allowInsecureLocalForTests?: boolean;
};

const LOOPBACK_HOSTS = ['127.0.0.1', '[::1]', 'localhost'];

/**
 * Whether a feed address may be read: HTTPS without embedded credentials, or
 * plain HTTP to loopback only where the service runs against a local fixture,
 * the same rule the mail and CalDAV connectors apply to their endpoints.
 */
export function icsFeedAddressUsable(address: string, allowInsecureLocal: boolean): boolean {
  if (!URL.canParse(address)) return false;
  const url = new URL(address);
  if (url.username || url.password) return false;
  return (
    url.protocol === 'https:' ||
    (allowInsecureLocal && url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname))
  );
}

/**
 * A published calendar feed, read fresh on every listing.
 *
 * The address is the credential: a private feed address carries its own token,
 * so it lives in the sealed store and is only ever opened for the one request
 * that needs it. The owner chose it when installing the connection; nothing a
 * runtime sends can change where this connector reads from. Redirects are
 * refused so the address cannot be forwarded somewhere else, and the feed is
 * parsed by the same read-only calendar code an imported file goes through.
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
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private load(signal?: AbortSignal): Promise<string> {
    return this.secrets.withSecret(this.config.secretRef, this.config.spaceId, async (address) => {
      if (!icsFeedAddressUsable(address, this.config.allowInsecureLocalForTests === true))
        throw new Error('Calendar feed address is not usable');
      const url = new URL(address);
      const response = await this.fetcher(url, {
        headers: { accept: 'text/calendar, text/plain;q=0.5' },
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Calendar feed unavailable');
      }
      return boundedText(response);
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
