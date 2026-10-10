/**
 * Twilio Programmable Messaging, reached over its REST API with the account
 * SID and auth token, and the check Twilio's own signature asks of every
 * request it sends to this service.
 *
 * - Sending: `POST /2010-04-01/Accounts/{AccountSid}/Messages.json` with `To`,
 *   `From` and `Body` (up to 1,600 characters), HTTP Basic authentication.
 *   https://www.twilio.com/docs/messaging/api/message-resource
 * - Incoming texts arrive as `application/x-www-form-urlencoded` with
 *   `MessageSid`, `AccountSid`, `From`, `To`, `Body` and `NumMedia`.
 *   https://www.twilio.com/docs/messaging/guides/webhook-request
 * - `X-Twilio-Signature`: the full URL Twilio called, then each POST parameter
 *   name and value in case-sensitive sorted order with no delimiters, signed
 *   with HMAC-SHA1 under the auth token and Base64-encoded.
 *   https://www.twilio.com/docs/usage/security
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SmsCredentials } from '@melete/contracts';

export const TWILIO_API = 'https://api.twilio.com';
const REQUEST_TIMEOUT_MS = 20_000;

export type TwilioFetch = (input: string, init: RequestInit) => Promise<Response>;
export type TwilioOptions = {
  /** Replaces the network. Only a test passes one. */
  fetch?: TwilioFetch;
  /** Replaces `https://api.twilio.com`. Only a test passes one. */
  base?: string;
};

/**
 * Why a call to Twilio did not succeed, by what it means for the caller:
 * `unavailable` is the one answer that leaves a send's outcome unknown, since
 * the request may have been acted on before the answer was lost.
 */
export class TwilioFailure extends Error {
  constructor(
    readonly code: 'credential_refused' | 'not_found' | 'refused' | 'rate_limited' | 'unavailable',
    readonly status?: number,
  ) {
    super(`twilio ${code}${status ? ` (${status})` : ''}`);
  }
}

export type TwilioMessage = {
  sid: string;
  to: string;
  from: string;
  body: string;
  status: string;
  date_created: string | null;
  error_code: number | null;
};

const message = (value: unknown): TwilioMessage | null => {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.sid !== 'string') return null;
  return {
    sid: row.sid,
    to: String(row.to ?? ''),
    from: String(row.from ?? ''),
    body: String(row.body ?? ''),
    status: String(row.status ?? ''),
    date_created: typeof row.date_created === 'string' ? row.date_created : null,
    error_code: typeof row.error_code === 'number' ? row.error_code : null,
  };
};

export class TwilioClient {
  private readonly fetcher: TwilioFetch;
  private readonly base: string;

  constructor(
    private readonly credentials: SmsCredentials,
    options: TwilioOptions = {},
  ) {
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.base = (options.base ?? TWILIO_API).replace(/\/+$/, '');
  }

  get from(): string {
    return this.credentials.from_number;
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    form?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const account = encodeURIComponent(this.credentials.account_sid);
    const url = `${this.base}/2010-04-01/Accounts/${account}${path}`;
    const auth = Buffer.from(
      `${this.credentials.account_sid}:${this.credentials.auth_token}`,
    ).toString('base64');
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers: {
          authorization: `Basic ${auth}`,
          accept: 'application/json',
          ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(form ? { body: new URLSearchParams(form).toString() } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new TwilioFailure('unavailable');
    }
    if (response.status === 401 || response.status === 403)
      throw new TwilioFailure('credential_refused', response.status);
    if (response.status === 404) throw new TwilioFailure('not_found', 404);
    if (response.status === 429) throw new TwilioFailure('rate_limited', 429);
    if (response.status >= 400 && response.status < 500)
      throw new TwilioFailure('refused', response.status);
    if (!response.ok) throw new TwilioFailure('unavailable', response.status);
    try {
      const body = (await response.json()) as unknown;
      if (!body || typeof body !== 'object') throw new Error('not an object');
      return body as Record<string, unknown>;
    } catch {
      throw new TwilioFailure('unavailable', response.status);
    }
  }

  /** The account itself: the cheapest request that proves the SID and token. */
  async account(): Promise<void> {
    await this.call('GET', '.json');
  }

  /** Create one outgoing message from the connection's number. */
  async send(to: string, body: string): Promise<TwilioMessage> {
    const created = message(
      await this.call('POST', '/Messages.json', {
        To: to,
        From: this.credentials.from_number,
        Body: body,
      }),
    );
    // Twilio answered 2xx, so the message exists; an answer without its sid is still a send.
    if (!created) throw new TwilioFailure('unavailable');
    return created;
  }

  /** The most recent messages from this number to one recipient, newest first. */
  async sentTo(to: string): Promise<TwilioMessage[]> {
    const query = new URLSearchParams({
      To: to,
      From: this.credentials.from_number,
      PageSize: '50',
    });
    const page = await this.call('GET', `/Messages.json?${query}`);
    const rows = Array.isArray(page.messages) ? page.messages : [];
    return rows.map(message).filter((row): row is TwilioMessage => row !== null);
  }

  /** The number's own sid on this account, or null when the account has no such number. */
  async numberSid(): Promise<string | null> {
    const query = new URLSearchParams({ PhoneNumber: this.credentials.from_number });
    const page = await this.call('GET', `/IncomingPhoneNumbers.json?${query}`);
    const rows = Array.isArray(page.incoming_phone_numbers) ? page.incoming_phone_numbers : [];
    const found = rows.find(
      (row): row is { sid: string } =>
        !!row && typeof row === 'object' && typeof (row as { sid?: unknown }).sid === 'string',
    );
    return found?.sid ?? null;
  }

  /** Have Twilio send the number's incoming texts to this address. */
  async receiveAt(numberSid: string, url: string): Promise<void> {
    await this.call('POST', `/IncomingPhoneNumbers/${encodeURIComponent(numberSid)}.json`, {
      SmsUrl: url,
      SmsMethod: 'POST',
    });
  }
}

/**
 * The signature Twilio sends in `X-Twilio-Signature` for a form POST to `url`.
 * Parameters are sorted by name, case-sensitively, and a repeated name by
 * value, as Twilio's own helper libraries do.
 */
export function twilioSignature(
  url: string,
  params: Iterable<[string, string]>,
  authToken: string,
): string {
  const sorted = [...params].sort(([leftName, leftValue], [rightName, rightValue]) =>
    leftName < rightName
      ? -1
      : leftName > rightName
        ? 1
        : leftValue < rightValue
          ? -1
          : leftValue > rightValue
            ? 1
            : 0,
  );
  const data = url + sorted.map(([name, value]) => `${name}${value}`).join('');
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

/** Whether a request carries Twilio's signature for this address and these parameters. */
export function validTwilioSignature(
  signature: string | undefined,
  url: string,
  params: Iterable<[string, string]>,
  authToken: string,
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(twilioSignature(url, params, authToken));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
