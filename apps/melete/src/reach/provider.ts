/**
 * The telephony provider behind texts and calls to the person's own number.
 * Twilio is the one built in; a test passes its own.
 */
import {
  TWILIO_UNSUBSCRIBED,
  TwilioClient,
  TwilioFailure,
  type TwilioFetch,
  validTwilioSignature,
} from './twilio.ts';

/**
 * Why a send did not go: `opted_out` the person replied STOP to this sender;
 * `refused` the provider turned it down, so nothing was sent; `unknown` the
 * answer was lost, so it may have been sent and is never sent again.
 */
export class ReachSendFailure extends Error {
  constructor(readonly kind: 'opted_out' | 'refused' | 'unknown') {
    super(`reach send ${kind}`);
  }
}

export type Sent = { ref: string; status: string };

export interface ReachProvider {
  /** The number texts and calls come from; it is also the caller ID. */
  readonly from: string;
  readonly name: string;
  text(to: string, body: string, statusCallback: string | null): Promise<Sent>;
  call(to: string, twiml: string, statusCallback: string | null): Promise<Sent>;
  /** Whether a webhook request came from the provider, for this exact address. */
  authentic(url: string, params: URLSearchParams, signature: string | undefined): boolean;
  /** The account named in a webhook request is this one. */
  ownAccount(params: URLSearchParams): boolean;
}

export type ReachPrices = { textUsd: number; callUsdPerMinute: number };

export class TwilioReach implements ReachProvider {
  readonly name = 'twilio';
  private readonly client: TwilioClient;

  constructor(
    private readonly credentials: { accountSid: string; authToken: string; fromNumber: string },
    options: { fetch?: TwilioFetch; base?: string } = {},
  ) {
    this.client = new TwilioClient(credentials, options);
  }

  get from(): string {
    return this.credentials.fromNumber;
  }

  private async send(work: () => Promise<{ sid: string; status: string }>): Promise<Sent> {
    try {
      const made = await work();
      return { ref: made.sid, status: made.status };
    } catch (error) {
      if (error instanceof TwilioFailure && error.code === TWILIO_UNSUBSCRIBED)
        throw new ReachSendFailure('opted_out');
      if (error instanceof TwilioFailure && error.kind !== 'unavailable')
        throw new ReachSendFailure('refused');
      throw new ReachSendFailure('unknown');
    }
  }

  text(to: string, body: string, statusCallback: string | null): Promise<Sent> {
    return this.send(() => this.client.text(to, body, statusCallback));
  }

  call(to: string, twiml: string, statusCallback: string | null): Promise<Sent> {
    return this.send(() => this.client.call(to, twiml, statusCallback));
  }

  authentic(url: string, params: URLSearchParams, signature: string | undefined): boolean {
    return validTwilioSignature(signature, url, params.entries(), this.credentials.authToken);
  }

  ownAccount(params: URLSearchParams): boolean {
    return params.get('AccountSid') === this.credentials.accountSid;
  }
}

export type ReachConfig = {
  provider: ReachProvider | null;
  /** The https address providers call back on, `/api` included; null without one. */
  callbackBase: string | null;
  /** When texts and calls are off here, the sentence that says so. */
  unavailable: string | null;
  prices: ReachPrices;
};

const PUSH_ONLY =
  'Texts and calls aren’t set up on this installation, so Melete reaches you by push only.';

/** Read the operator's telephony settings. Without all of them, the ladder stops at push. */
export function reachConfigFromEnv(env: {
  MELETE_TWILIO_ACCOUNT_SID?: string | undefined;
  MELETE_TWILIO_AUTH_TOKEN?: string | undefined;
  MELETE_TWILIO_FROM_NUMBER?: string | undefined;
  MELETE_PUBLIC_URL?: string | undefined;
  MELETE_REACH_TEXT_USD: number;
  MELETE_REACH_CALL_USD_PER_MINUTE: number;
}): ReachConfig {
  const prices = {
    textUsd: env.MELETE_REACH_TEXT_USD,
    callUsdPerMinute: env.MELETE_REACH_CALL_USD_PER_MINUTE,
  };
  const callbackBase = callbackBaseOf(env.MELETE_PUBLIC_URL);
  if (
    !env.MELETE_TWILIO_ACCOUNT_SID ||
    !env.MELETE_TWILIO_AUTH_TOKEN ||
    !env.MELETE_TWILIO_FROM_NUMBER ||
    !callbackBase
  )
    return { provider: null, callbackBase, unavailable: PUSH_ONLY, prices };
  return {
    provider: new TwilioReach({
      accountSid: env.MELETE_TWILIO_ACCOUNT_SID,
      authToken: env.MELETE_TWILIO_AUTH_TOKEN,
      fromNumber: env.MELETE_TWILIO_FROM_NUMBER,
    }),
    callbackBase,
    unavailable: null,
    prices,
  };
}

/**
 * Replies, keypresses and delivery receipts reach the service through the web
 * app's `/api` prefix at the public address, which must be https.
 */
export function callbackBaseOf(publicUrl: string | undefined): string | null {
  if (!publicUrl) return null;
  try {
    const url = new URL(publicUrl);
    if (url.protocol !== 'https:') return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}/api`;
  } catch {
    return null;
  }
}
