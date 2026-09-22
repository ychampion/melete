/**
 * Signing the installation in to a model provider. The owner signs in once;
 * the service seals the tokens and the gateway uses and refreshes them. No
 * body here carries a token, a code verifier or a refresh token.
 */
import { z } from 'zod';
import { timestamp } from './common.ts';

export const SIGN_IN_PROVIDERS = ['chatgpt', 'openai-compatible'] as const;
export const signInProvider = z.enum(SIGN_IN_PROVIDERS);

export const signInMethod = z.enum(['device', 'browser']);

export const providerSignInStatus = z
  .object({
    provider: signInProvider,
    label: z.string().meta({
      description: 'The provider as the person knows it, for a "Sign in with" button',
    }),
    state: z.enum(['signed_out', 'pending', 'signed_in', 'sign_in_required']).meta({
      description:
        '`sign_in_required` means the provider refused a refresh; model calls to it are refused ' +
        'with `provider_sign_in_required` until the owner signs in again.',
    }),
    account: z
      .string()
      .nullable()
      .meta({ description: 'The signed-in account, when the provider names one' }),
    expires_at: timestamp.nullable().meta({
      description: 'When the current access token expires. The gateway refreshes before then.',
    }),
    reason: z
      .enum([
        'refresh_expired',
        'refresh_reused',
        'refresh_revoked',
        'refresh_refused',
        'access_expired',
      ])
      .nullable()
      .meta({ description: 'Why a new sign-in is needed' }),
    message: z
      .string()
      .nullable()
      .meta({
        description:
          'What happened and what to do, in plain words, whenever the person has something to do; ' +
          'null when signed in or signed out.',
      }),
    methods: z.array(signInMethod),
  })
  .strict();

export const providerSignInList = z.object({ providers: z.array(providerSignInStatus) }).strict();

export const startSignInRequest = z
  .object({
    method: signInMethod.optional().meta({
      description:
        '`device` shows a code to enter at the provider; `browser` returns an address to open, ' +
        'after which the address the browser was sent back to is pasted into complete. Left ' +
        'out, the provider’s first method.',
    }),
  })
  .strict();

export const startSignInResponse = z.discriminatedUnion('method', [
  z
    .object({
      sign_in_id: z.string(),
      method: z.literal('device'),
      verification_url: z.url(),
      user_code: z.string(),
      interval: z
        .number()
        .int()
        .positive()
        .meta({ description: 'Seconds between completion checks' }),
      expires_at: timestamp,
    })
    .strict(),
  z
    .object({
      sign_in_id: z.string(),
      method: z.literal('browser'),
      authorize_url: z.url(),
      redirect_uri: z.url(),
      expires_at: timestamp,
    })
    .strict(),
]);

export const completeSignInRequest = z
  .object({
    sign_in_id: z.string().min(1).max(128),
    callback_url: z
      .string()
      .min(1)
      .max(8192)
      .optional()
      .meta({
        description:
          'For a browser sign-in: the whole address the provider sent the browser back to. ' +
          'Its state must match the sign-in it completes.',
      }),
  })
  .strict();

export const completeSignInPending = z
  .object({
    state: z.literal('pending'),
    interval: z.number().int().positive(),
  })
  .strict();
