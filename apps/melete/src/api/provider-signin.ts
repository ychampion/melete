/**
 * The owner's model-provider sign-ins. Only the setup owner may start, finish,
 * read or end one: a provider credential serves every space on the
 * installation. No response carries a token; a failed sign-in answers with a
 * fixed code and sentence, never the issuer's own text.
 */
import {
  completeSignInPending,
  completeSignInRequest,
  providerSignInList,
  providerSignInStatus,
  startSignInRequest,
  startSignInResponse,
} from '@melete/contracts';
import type { Context, Hono } from 'hono';
import type { Database } from '../db/client.ts';
import { owner } from '../db/schema.ts';
import type { ProviderSignIn } from '../gateway/credentials.ts';
import { OAuthFailure } from '../gateway/oauth.ts';
import { ServiceError } from './errors.ts';

const FAILURES: Record<string, { status: 400 | 404 | 502; message: string }> = {
  sign_in_not_found: {
    status: 404,
    message: 'That sign-in has expired or was replaced. Start again.',
  },
  callback_invalid: {
    status: 400,
    message: 'Paste the whole address the provider sent the browser back to.',
  },
  state_mismatch: {
    status: 400,
    message: 'That address belongs to a different sign-in. Start again and paste the new one.',
  },
  sign_in_declined: { status: 400, message: 'The provider did not approve the sign-in.' },
  device_sign_in_unavailable: {
    status: 400,
    message: 'This provider has no device sign-in. Use the browser method.',
  },
  code_exchange_refused: {
    status: 502,
    message: 'The provider refused the sign-in code. Start again.',
  },
  device_code_refused: { status: 502, message: 'The provider refused the device sign-in.' },
};

function failure(error: unknown): never {
  if (error instanceof OAuthFailure) {
    const known = FAILURES[error.code];
    throw new ServiceError(
      error.code in FAILURES ? error.code : 'provider_unreachable',
      known?.message ?? 'The provider could not be reached for sign-in. Try again shortly.',
      known?.status ?? 502,
    );
  }
  throw error;
}

export function mountProviderSignIn(
  app: Hono,
  deps: { db: Database; signIn: ProviderSignIn | undefined },
): void {
  const { db, signIn } = deps;

  /** The setup owner, and a sign-in service that can seal what it is given. */
  async function authorize(c: Context, provider?: string) {
    const [installation] = await db.select({ id: owner.id }).from(owner).limit(1);
    const actor = c.get('owner')?.id;
    if (!installation || installation.id !== actor)
      throw new ServiceError(
        'owner_required',
        'Only the setup owner can manage model sign-in.',
        403,
      );
    if (!signIn)
      throw new ServiceError(
        'sign_in_unavailable',
        'Model sign-in needs MELETE_MASTER_KEY to seal what the provider issues.',
        503,
      );
    if (provider !== undefined && !signIn.handles(provider))
      throw new ServiceError(
        'provider_not_available',
        'This installation offers no sign-in for that provider.',
        404,
      );
    return { service: signIn, ownerId: installation.id };
  }

  app.get('/model-providers/sign-in', async (c) => {
    const { service } = await authorize(c);
    const providers = await Promise.all(service.providers.map((name) => service.status(name)));
    return c.json(providerSignInList.parse({ providers }));
  });

  app.get('/model-providers/:provider/sign-in', async (c) => {
    const provider = c.req.param('provider');
    const { service } = await authorize(c, provider);
    return c.json(providerSignInStatus.parse(await service.status(provider)));
  });

  app.post('/model-providers/:provider/sign-in', async (c) => {
    const provider = c.req.param('provider');
    const { service, ownerId } = await authorize(c, provider);
    const input = startSignInRequest.parse(await c.req.json().catch(() => ({})));
    const started = await service.start(provider, ownerId, input.method).catch(failure);
    return c.json(startSignInResponse.parse(started), 201);
  });

  app.post('/model-providers/:provider/sign-in/complete', async (c) => {
    const provider = c.req.param('provider');
    const { service, ownerId } = await authorize(c, provider);
    const input = completeSignInRequest.parse(await c.req.json());
    const result = await service.complete(provider, ownerId, input).catch(failure);
    if (result.state === 'pending') return c.json(completeSignInPending.parse(result), 202);
    return c.json(providerSignInStatus.parse(result));
  });

  app.delete('/model-providers/:provider/sign-in', async (c) => {
    const provider = c.req.param('provider');
    const { service } = await authorize(c, provider);
    return c.json(providerSignInStatus.parse(await service.signOut(provider).catch(failure)));
  });
}
