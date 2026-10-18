/**
 * The routes for connection pages and entitlements in the OpenAPI document.
 */
import { z } from 'zod';
import { errorResponse } from './api.ts';
import {
  connectionPageList,
  connectionPageView,
  entitlementGrantInput,
  entitlementList,
  pageReport,
} from './connection-pages.ts';

const json = <T extends z.ZodType>(schema: T) => ({
  content: { 'application/json': { schema } },
});
const jsonResponse = <T extends z.ZodType>(description: string, schema: T) => ({
  description,
  ...json(schema),
});
const problem = (description: string) => jsonResponse(description, errorResponse);
const idParam = (description: string) => ({
  path: z.object({ id: z.string().meta({ description }) }),
});

const reportAccepted = z
  .strictObject({ ok: z.literal(true), state: z.string(), repeated: z.boolean() })
  .meta({ id: 'ConnectionPageReportAccepted' });

const jwks = z
  .strictObject({
    keys: z.array(
      z.strictObject({
        kty: z.literal('OKP'),
        crv: z.literal('Ed25519'),
        x: z.string(),
        kid: z.string(),
        alg: z.literal('EdDSA'),
        use: z.literal('sig'),
      }),
    ),
  })
  .meta({ id: 'IdentityKeySet' });

export const pagesPaths = () => ({
  '/conversations/{id}/pages': {
    get: {
      tags: ['pages'],
      summary: "The pages a conversation's connections showed, newest first",
      requestParams: idParam('Conversation id'),
      responses: {
        '200': jsonResponse('Pages', connectionPageList),
        '404': problem('No such conversation, or this person cannot read it'),
      },
    },
  },
  '/pages/{id}/views': {
    post: {
      tags: ['pages'],
      summary: 'A frame for one open page, in this browser session',
      description:
        'Answers with a path below the API that serves the page into a sandboxed frame, ' +
        'and the tool call input and result the page is handed. Signed-in browser sessions only.',
      requestParams: idParam('Page id'),
      responses: {
        '200': jsonResponse('Frame', connectionPageView),
        '403': problem('Not a browser session'),
        '404': problem('No such open page, or this person cannot see it'),
      },
    },
  },
  '/pages/view/{token}': {
    get: {
      tags: ['pages'],
      summary: 'A page, as its frame loads it',
      description:
        'No session is read: the token names one page, one person and one browser session, ' +
        'and the page must still be open and that session signed in. Served with ' +
        '`Content-Security-Policy: sandbox allow-scripts allow-forms` and only the domains ' +
        'the page declared that its connection allows. A browser asking for it as a page of ' +
        'its own, rather than in a frame, is refused.',
      security: [],
      requestParams: {
        path: z.object({ token: z.string().meta({ description: 'The view token' }) }),
      },
      responses: {
        '200': {
          description: 'The page',
          content: { 'text/html': { schema: z.string() } },
        },
        '403': problem('Opened as a page of its own rather than framed'),
        '404': problem('An unknown, expired or ended view'),
      },
    },
  },
  '/pages/{id}/outcome': {
    post: {
      tags: ['pages'],
      summary: "A connection's server reports what happened on its page",
      security: [],
      description:
        'No session. Signed like a Standard Webhooks message (`webhook-id`, ' +
        '`webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256>`) with the ' +
        "page's report key, which the server received with the tool call that showed the " +
        'page. Settles an open page once; the same report again is answered as before.',
      requestParams: idParam('Page id'),
      requestBody: json(pageReport),
      responses: {
        '200': jsonResponse('Settled', reportAccepted),
        '400': problem('Not a page report'),
        '401': problem('Not signed for this page'),
        '404': problem('No such page'),
        '409': problem('Already settled differently'),
        '410': problem('The page expired first'),
      },
    },
  },
  '/.well-known/jwks.json': {
    get: {
      tags: ['identity'],
      summary: 'The keys identity assertions are signed with',
      security: [],
      description:
        'A connection that asks for identity is sent a JWT (EdDSA) in the `Melete-Identity` ' +
        'header with each call: `iss` this API, `aud` its own origin, `sub` an id for the ' +
        'person at that audience, `ent` their entitlements, valid five minutes.',
      responses: { '200': jsonResponse('Key set', jwks) },
    },
  },
  '/operator/people/{id}/entitlements': {
    get: {
      tags: ['entitlements'],
      summary: "An account's entitlements",
      description: 'The account that set Melete up only.',
      requestParams: idParam('Account id'),
      responses: {
        '200': jsonResponse('Entitlements', entitlementList),
        '403': problem('Not the account that set Melete up'),
      },
    },
  },
  '/operator/people/{id}/entitlements/{key}': {
    put: {
      tags: ['entitlements'],
      summary: 'Grant an entitlement, or change its value and expiry',
      description: 'The account that set Melete up only.',
      requestParams: {
        path: z.object({
          id: z.string().meta({ description: 'Account id' }),
          key: z.string().meta({ description: 'Entitlement name' }),
        }),
      },
      requestBody: json(entitlementGrantInput),
      responses: {
        '200': jsonResponse('Entitlements', entitlementList),
        '400': problem('Not an entitlement name, or not a grant'),
        '403': problem('Not the account that set Melete up'),
        '404': problem('No such account'),
      },
    },
    delete: {
      tags: ['entitlements'],
      summary: 'Take an entitlement away',
      description: 'The account that set Melete up only. Calls not yet made are refused.',
      requestParams: {
        path: z.object({
          id: z.string().meta({ description: 'Account id' }),
          key: z.string().meta({ description: 'Entitlement name' }),
        }),
      },
      responses: {
        '200': jsonResponse('Entitlements', entitlementList),
        '403': problem('Not the account that set Melete up'),
      },
    },
  },
});
