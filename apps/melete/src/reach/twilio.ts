/**
 * Twilio, reached over its REST API with the account SID and auth token, and
 * the check Twilio's own signature asks of every request it sends here.
 *
 * - Texts: `POST /2010-04-01/Accounts/{AccountSid}/Messages.json` with `To`,
 *   `From`, `Body` and `StatusCallback`.
 *   https://www.twilio.com/docs/messaging/api/message-resource
 * - Calls: `POST /2010-04-01/Accounts/{AccountSid}/Calls.json` with `To`,
 *   `From`, `Twiml` and `StatusCallback`.
 *   https://www.twilio.com/docs/voice/api/call-resource
 * - `X-Twilio-Signature`: the full URL Twilio called, then each POST parameter
 *   name and value in case-sensitive sorted order with no delimiters, signed
 *   with HMAC-SHA1 under the auth token and Base64-encoded.
 *   https://www.twilio.com/docs/usage/security
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const TWILIO_API = 'https://api.twilio.com';
const REQUEST_TIMEOUT_MS = 20_000;
/** Twilio's answer when the recipient replied STOP to this sender. */
export const TWILIO_UNSUBSCRIBED = 21610;

export type TwilioCredentials = { accountSid: string; authToken: string; fromNumber: string };
export type TwilioFetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Why a request to Twilio did not succeed: `unavailable` is the one answer
 * that leaves a send's outcome unknown, since the request may have been acted
 * on before the answer was lost. `code` is Twilio's own error number.
 */
export class TwilioFailure extends Error {
  constructor(
    readonly kind: 'credential_refused' | 'not_found' | 'refused' | 'rate_limited' | 'unavailable',
    readonly status?: number,
    readonly code?: number,
  ) {
    super(`twilio ${kind}${status ? ` (${status})` : ''}${code ? ` code ${code}` : ''}`);
  }
}

export type TwilioCreated = { sid: string; status: string };

export class TwilioClient {
  private readonly fetcher: TwilioFetch;
  private readonly base: string;

  constructor(
    private readonly credentials: TwilioCredentials,
    options: { fetch?: TwilioFetch; base?: string } = {},
  ) {
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.base = (options.base ?? TWILIO_API).replace(/\/+$/, '');
  }

  get from(): string {
    return this.credentials.fromNumber;
  }

  private async post(path: string, form: Record<string, string>): Promise<TwilioCreated> {
    const account = encodeURIComponent(this.credentials.accountSid);
    const url = `${this.base}/2010-04-01/Accounts/${account}${path}`;
    const auth = Buffer.from(
      `${this.credentials.accountSid}:${this.credentials.authToken}`,
    ).toString('base64');
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: 'POST',
        headers: {
          authorization: `Basic ${auth}`,
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(form).toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new TwilioFailure('unavailable');
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed = (await response.json()) as unknown;
      if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
    } catch {
      // An answer without a body is judged by its status alone.
    }
    const code = typeof body.code === 'number' ? body.code : undefined;
    if (response.status === 401 || response.status === 403)
      throw new TwilioFailure('credential_refused', response.status, code);
    if (response.status === 404) throw new TwilioFailure('not_found', 404, code);
    if (response.status === 429) throw new TwilioFailure('rate_limited', 429, code);
    if (response.status >= 400 && response.status < 500)
      throw new TwilioFailure('refused', response.status, code);
    if (!response.ok) throw new TwilioFailure('unavailable', response.status, code);
    // Twilio answered 2xx, so the message or call exists; one without its sid is still made.
    if (typeof body.sid !== 'string') throw new TwilioFailure('unavailable', response.status);
    return { sid: body.sid, status: String(body.status ?? '') };
  }

  /** One text from this number. */
  text(to: string, body: string, statusCallback: string | null): Promise<TwilioCreated> {
    return this.post('/Messages.json', {
      To: to,
      From: this.credentials.fromNumber,
      Body: body,
      ...(statusCallback ? { StatusCallback: statusCallback } : {}),
    });
  }

  /** One call from this number that plays `twiml` when answered. */
  call(to: string, twiml: string, statusCallback: string | null): Promise<TwilioCreated> {
    return this.post('/Calls.json', {
      To: to,
      From: this.credentials.fromNumber,
      Twiml: twiml,
      Timeout: '30',
      ...(statusCallback
        ? { StatusCallback: statusCallback, StatusCallbackEvent: 'completed' }
        : {}),
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

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};
export const xml = (text: string) => text.replace(/[&<>"']/g, (c) => XML_ESCAPES[c] ?? c);
