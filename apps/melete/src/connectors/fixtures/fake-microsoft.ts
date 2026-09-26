/**
 * A loopback stand-in for Microsoft's identity platform and the parts of
 * Microsoft Graph that mail and calendar use, for tests only. The token
 * endpoint checks PKCE, the client, its secret and the redirect address, and
 * rotates the refresh token on every refresh. Every Graph call needs a current
 * access token carrying the scope that call needs. It answers the way Graph
 * does where that matters to the client: short scope names, weak ETags, times
 * with seven fractional digits, text bodies with a trailing line break.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { MicrosoftEndpoints } from '../microsoft.ts';

export type FakeMicrosoftOptions = {
  email?: string;
  /** Graph scope names the person leaves ticked; every one asked for by default. */
  grant?: string[];
  decline?: boolean;
  refreshRefused?: boolean;
  /** Give a message sent through Graph a Message-ID of its own. */
  rewriteMessageId?: boolean;
  idTokenAudience?: string;
  idTokenIssuer?: string;
};

type Stored = { id: string; raw: Buffer };
type GraphEvent = Record<string, unknown> & {
  id: string;
  '@odata.etag': string;
  transactionId?: string;
  singleValueExtendedProperties?: { id: string; value: string }[];
};

export type FakeMicrosoft = {
  endpoints: MicrosoftEndpoints;
  client: { clientId: string; clientSecret: string };
  tokenRequests: URLSearchParams[];
  issued: string[];
  sent: Stored[];
  events: Map<string, GraphEvent>;
  deliver(raw: string): string;
  expireAccess(): void;
  stop(): Promise<void>;
};

export const PERSONAL_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
const ALL_SCOPES = ['User.Read', 'Mail.Read', 'Mail.Send', 'Calendars.ReadWrite'];

const headerOf = (raw: Buffer, name: string): string | undefined => {
  const head = raw.toString('utf8').split(/\r?\n\r?\n/)[0] ?? '';
  const match = new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(head);
  return match?.[1]?.trim();
};

const markOf = (event: GraphEvent) =>
  event.singleValueExtendedProperties?.find((property) => property.id.endsWith('melete_mark'))
    ?.value;

export async function startFakeMicrosoft(
  options: FakeMicrosoftOptions = {},
): Promise<FakeMicrosoft> {
  const email = options.email ?? 'person@outlook.example';
  const client = { clientId: '00000000-fake-4000-8000-client000001', clientSecret: 'fake-secret' };
  const granted = options.grant ?? ALL_SCOPES;
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const access = new Map<string, Set<string>>();
  const refresh = new Set<string>();
  const inbox: Stored[] = [];
  const transactions = new Map<string, string>();
  const state = {
    tokenRequests: [] as URLSearchParams[],
    issued: [] as string[],
    sent: [] as Stored[],
    events: new Map<string, GraphEvent>(),
  };
  let serial = 0;
  const nextId = () => `AAMkAG${(++serial).toString().padStart(6, '0')}AAA=`;
  const token = (prefix: string) => {
    const value = `${prefix}${randomBytes(12).toString('hex')}`;
    state.issued.push(value);
    return value;
  };
  const idToken = () => {
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${part({ alg: 'none' })}.${part({
      iss: options.idTokenIssuer ?? `https://login.microsoftonline.com/${PERSONAL_TENANT}/v2.0`,
      aud: options.idTokenAudience ?? client.clientId,
      preferred_username: email,
      tid: PERSONAL_TENANT,
    })}.`;
  };
  const tokenAnswer = (withIdToken: boolean) => {
    const accessToken = token('eyJ0eXAi.');
    access.set(accessToken, new Set(granted.map((scope) => scope.toLowerCase())));
    const refreshToken = token('M.C1_BAY.');
    refresh.add(refreshToken);
    return {
      token_type: 'Bearer',
      // Graph lists the short names of what was granted.
      scope: [...granted, 'openid', 'email', 'offline_access'].join(' '),
      expires_in: 3600,
      access_token: accessToken,
      refresh_token: refreshToken,
      ...(withIdToken ? { id_token: idToken() } : {}),
    };
  };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request): Promise<Response> => {
      const url = new URL(request.url);
      const at = url.pathname;
      if (at === '/common/oauth2/v2.0/authorize') {
        const back = new URL(url.searchParams.get('redirect_uri') ?? '');
        back.searchParams.set('state', url.searchParams.get('state') ?? '');
        if (options.decline) back.searchParams.set('error', 'access_denied');
        else {
          const code = `M.C5_${randomBytes(12).toString('hex')}`;
          codes.set(code, {
            challenge: url.searchParams.get('code_challenge') ?? '',
            redirectUri: url.searchParams.get('redirect_uri') ?? '',
          });
          back.searchParams.set('code', code);
        }
        return new Response(null, { status: 302, headers: { location: back.href } });
      }
      if (at === '/common/oauth2/v2.0/token' && request.method === 'POST') {
        const fields = new URLSearchParams(await request.text());
        state.tokenRequests.push(fields);
        const clientOk =
          fields.get('client_id') === client.clientId &&
          fields.get('client_secret') === client.clientSecret;
        if (fields.get('grant_type') === 'authorization_code') {
          const grant = codes.get(fields.get('code') ?? '');
          codes.delete(fields.get('code') ?? '');
          const verified =
            clientOk &&
            grant &&
            grant.redirectUri === fields.get('redirect_uri') &&
            createHash('sha256')
              .update(fields.get('code_verifier') ?? '')
              .digest('base64url') === grant.challenge;
          if (!verified) return Response.json({ error: 'invalid_grant' }, { status: 400 });
          return Response.json(tokenAnswer(true));
        }
        if (fields.get('grant_type') === 'refresh_token') {
          const presented = fields.get('refresh_token') ?? '';
          if (options.refreshRefused || !clientOk || !refresh.has(presented))
            return Response.json({ error: 'invalid_grant' }, { status: 400 });
          // The refresh token rotates: the one presented is spent.
          refresh.delete(presented);
          return Response.json(tokenAnswer(false));
        }
        return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
      }

      const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      const scopes = access.get(bearer);
      if (!scopes)
        return Response.json({ error: { code: 'InvalidAuthenticationToken' } }, { status: 401 });
      const needs = (scope: string) =>
        scopes.has(scope.toLowerCase())
          ? null
          : Response.json({ error: { code: 'ErrorAccessDenied' } }, { status: 403 });
      const me = '/v1.0/me';
      if (!at.startsWith(me)) return new Response('not found', { status: 404 });
      const rest = at.slice(me.length);

      if (rest === '') {
        const refused = needs('User.Read');
        return refused ?? Response.json({ mail: email, userPrincipalName: email });
      }
      if (rest === '/sendMail' && request.method === 'POST') {
        const refused = needs('Mail.Send');
        if (refused) return refused;
        if (!request.headers.get('content-type')?.startsWith('text/plain'))
          return Response.json({ error: { code: 'ErrorInvalidRequest' } }, { status: 400 });
        let raw = Buffer.from(await request.text(), 'base64');
        if (options.rewriteMessageId)
          raw = Buffer.from(
            raw
              .toString('utf8')
              .replace(/^Message-ID:.*$/im, `Message-ID: <${nextId()}@outlook.example>`),
          );
        state.sent.push({ id: nextId(), raw });
        return new Response(null, { status: 202 });
      }
      if (rest.startsWith('/mailFolders') || rest.startsWith('/messages')) {
        const refused = needs('Mail.Read');
        if (refused) return refused;
        if (rest === '/mailFolders/inbox') return Response.json({ id: 'inbox' });
        if (rest === '/mailFolders/inbox/messages') {
          const q = (url.searchParams.get('$search') ?? '').replaceAll('"', '').toLowerCase();
          const top = Number(url.searchParams.get('$top') ?? 10);
          const pool = inbox.filter((m) => !q || m.raw.toString('utf8').toLowerCase().includes(q));
          return Response.json({
            value: [...pool]
              .reverse()
              .slice(0, top)
              .map((m) => ({ id: m.id })),
          });
        }
        if (rest === '/mailFolders/sentitems/messages') {
          const filter = url.searchParams.get('$filter') ?? '';
          const exact = /^internetMessageId eq '(.*)'$/.exec(filter);
          if (exact) {
            const wanted = exact[1]?.replaceAll("''", "'");
            return Response.json({
              value: state.sent
                .filter((m) => headerOf(m.raw, 'Message-ID') === wanted)
                .map((m) => ({ id: m.id, internetMessageId: headerOf(m.raw, 'Message-ID') })),
            });
          }
          return Response.json({
            value: [...state.sent].reverse().map((m) => ({
              id: m.id,
              internetMessageHeaders: ['Message-ID', 'X-Melete-Message-Id']
                .map((name) => ({ name, value: headerOf(m.raw, name) }))
                .filter((header) => header.value !== undefined),
            })),
          });
        }
        const raw = /^\/messages\/([^/]+)\/\$value$/.exec(rest);
        if (raw) {
          const found = [...inbox, ...state.sent].find(
            (m) => m.id === decodeURIComponent(raw[1] ?? ''),
          );
          return found
            ? new Response(found.raw, { headers: { 'content-type': 'message/rfc822' } })
            : Response.json({ error: { code: 'ErrorItemNotFound' } }, { status: 404 });
        }
      }
      if (rest.startsWith('/events')) {
        const refused = needs('Calendars.ReadWrite');
        if (refused) return refused;
        const shown = (event: GraphEvent) => ({
          ...event,
          start: {
            ...(event.start as object),
            dateTime: `${(event.start as { dateTime: string }).dateTime}0000`,
          },
          end: {
            ...(event.end as object),
            dateTime: `${(event.end as { dateTime: string }).dateTime}0000`,
          },
          body: {
            contentType: 'text',
            content: `${(event.body as { content?: string })?.content ?? ''}\r\n`,
          },
        });
        if (rest === '/events' && request.method === 'GET') {
          const filter = url.searchParams.get('$filter') ?? '';
          const prefix = /startswith\(ep\/value, '(.*)'\)\)$/
            .exec(filter)?.[1]
            ?.replaceAll("''", "'");
          const events = [...state.events.values()].filter(
            (event) => prefix === undefined || (markOf(event) ?? '').startsWith(prefix),
          );
          return Response.json({ value: events.map(shown) });
        }
        if (rest === '/events' && request.method === 'POST') {
          const body = (await request.json()) as Record<string, unknown>;
          const transaction =
            typeof body.transactionId === 'string' ? body.transactionId : undefined;
          const earlier = transaction ? transactions.get(transaction) : undefined;
          if (earlier) {
            const event = state.events.get(earlier);
            if (event) return Response.json(shown(event), { status: 201 });
          }
          const event: GraphEvent = { ...body, id: nextId(), '@odata.etag': 'W/"1"' } as GraphEvent;
          state.events.set(event.id, event);
          if (transaction) transactions.set(transaction, event.id);
          return Response.json(shown(event), { status: 201 });
        }
        const one = /^\/events\/([^/]+)$/.exec(rest);
        if (one) {
          const event = state.events.get(decodeURIComponent(one[1] ?? ''));
          if (!event)
            return Response.json({ error: { code: 'ErrorItemNotFound' } }, { status: 404 });
          if (request.method === 'GET') return Response.json(shown(event));
          if (request.headers.get('if-match') !== event['@odata.etag'])
            return Response.json({ error: { code: 'ErrorIrresolvableConflict' } }, { status: 412 });
          if (request.method === 'DELETE') {
            state.events.delete(event.id);
            return new Response(null, { status: 204 });
          }
          if (request.method === 'PATCH') {
            const body = (await request.json()) as Record<string, unknown>;
            const version = Number(event['@odata.etag'].replace(/\D/g, '')) + 1;
            const next = {
              ...event,
              ...body,
              id: event.id,
              '@odata.etag': `W/"${version}"`,
            } as GraphEvent;
            state.events.set(event.id, next);
            return Response.json(shown(next));
          }
        }
      }
      return new Response('not found', { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return {
    endpoints: {
      authorize: `${origin}/common/oauth2/v2.0/authorize`,
      token: `${origin}/common/oauth2/v2.0/token`,
      graph: `${origin}/v1.0/me`,
    },
    client,
    ...state,
    deliver(raw: string) {
      const stored = { id: nextId(), raw: Buffer.from(raw.replace(/\r?\n/g, '\r\n')) };
      inbox.push(stored);
      return stored.id;
    },
    expireAccess() {
      access.clear();
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}
