/**
 * Recall.ai webhook signatures (docs.recall.ai, "Verifying webhooks"):
 * headers `webhook-id`, `webhook-timestamp` and `webhook-signature`; the
 * signed content is `{id}.{timestamp}.{raw body}`; the key is the base64 part
 * of a `whsec_` verification secret; the signature is HMAC-SHA256, base64,
 * given as `v1,<signature>`. The header may carry several space-separated
 * signatures while a secret is rotated, and any one of them may match.
 *
 * Recall's page names no timestamp tolerance. Five minutes either way is the
 * window this service allows, so a captured request cannot be replayed later.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export type WebhookHeaders = {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
};

export function verifyRecallSignature(
  secret: string,
  headers: WebhookHeaders,
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !secret.startsWith('whsec_')) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  if (!key.length) return false;
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
  return signature.split(' ').some((entry) => {
    const [version, value] = entry.split(',', 2);
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** Sign a body the way Recall does; only a test calls this. */
export function signRecallWebhook(secret: string, id: string, timestamp: string, body: string) {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}
