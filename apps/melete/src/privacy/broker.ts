/**
 * The broker's side of the privacy router.
 *
 * Replies are rehydrated in the gateway, so a proposal normally arrives with
 * real values already. This is the second line for anything that still carries
 * a placeholder, such as an escaped form a model wrote into its arguments: it is
 * resolved against the conversation's vault here, inside the broker's listener
 * and before the broker canonicalises the payload, so the approval card, the
 * payload hash and the dispatched effect all carry the real value. A
 * placeholder the conversation never made is refused rather than sent on
 * literally to a payee or a recipient.
 */
import { verifyCapability } from '../broker/capability.ts';
import type { PrivacyRouter } from './router.ts';

type Fetcher = (request: Request) => Response | Promise<Response>;

/** Runtime routes whose bodies become payloads, narration or reactions. */
const RESOLVED = /^\/(?:actions|reactions|say|attempt\/wait|tools\/call)$/;

function rebuild(request: Request, body: string): Request {
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request.url, { method: request.method, headers, body });
}

export function withPlaceholderResolution(
  fetcher: Fetcher,
  options: { capabilityKey: string; router: () => PrivacyRouter | null },
): (request: Request) => Promise<Response> {
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST' || !RESOLVED.test(path)) return fetcher(request);
    const text = await request.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fetcher(rebuild(request, text));
    }
    const router = options.router();
    if (!router || !JSON.stringify(parsed).includes('⟦')) return fetcher(rebuild(request, text));
    const header = request.headers.get('authorization') ?? '';
    let claims: { job_id: string; attempt_id: string };
    try {
      claims = verifyCapability(header.replace(/^Bearer /, ''), options.capabilityKey);
    } catch {
      // The broker refuses an unauthenticated call itself; nothing is resolved for it.
      return fetcher(rebuild(request, text));
    }
    const result = await router.resolvePayload(claims.job_id, claims.attempt_id, parsed);
    if (result.unknown.length)
      return Response.json(
        {
          error: {
            code: 'payload_invalid',
            message: `${result.unknown.join(', ')} ${result.unknown.length === 1 ? 'is' : 'are'} not a detail from this conversation. Use a placeholder the conversation contains, or ask the person for the value.`,
          },
        },
        { status: 400 },
      );
    return fetcher(rebuild(request, JSON.stringify(result.value)));
  };
}
