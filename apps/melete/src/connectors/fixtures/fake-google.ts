/**
 * A loopback stand-in for Google's sign-in, Gmail API and Calendar API, for
 * tests only. The token endpoint checks PKCE, the client, its secret and the
 * redirect address; every API call needs a current access token carrying the
 * scope that call needs. Switches make it grant less, refuse a refresh, or give
 * a sent message a Message-ID of its own, so a test can see the client cope.
 */
import { createHash, randomBytes } from 'node:crypto';
import { GOOGLE_SCOPES, GOOGLE_SIGN_IN_SCOPE, type GoogleEndpoints } from '../google.ts';

export type FakeGoogleOptions = {
  email?: string;
  /** The scopes the person leaves ticked; every one asked for by default. */
  grant?: string[];
  /** Answer the authorization request with `error=access_denied`. */
  decline?: boolean;
  /** Refuse every refresh as `invalid_grant`, as for a revoked or expired grant. */
  refreshRefused?: boolean;
  /** Give a message sent through the API a Message-ID of Gmail's own. */
  rewriteMessageId?: boolean;
  /** Issue the id token for another client. */
  idTokenAudience?: string;
};

type Stored = { id: string; raw: Buffer; labels: string[] };
type Event = Record<string, unknown> & { id: string; etag: string; status?: string };

export type FakeGoogle = {
  endpoints: GoogleEndpoints;
  client: { clientId: string; clientSecret: string };
  authorizeRequests: URLSearchParams[];
  tokenRequests: URLSearchParams[];
  /** Every token handed out, to search logs and answers for. */
  issued: string[];
  sent: Stored[];
  events: Map<string, Event>;
  deliver(raw: string): string;
  /** Make every access token handed out so far stale, so the next call must refresh. */
  expireAccess(): void;
  stop(): Promise<void>;
};

const headerOf = (raw: Buffer, name: string): string | undefined => {
  const head = raw.toString('utf8').split(/\r?\n\r?\n/)[0] ?? '';
  const match = new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(head);
  return match?.[1]?.trim();
};

export async function startFakeGoogle(options: FakeGoogleOptions = {}): Promise<FakeGoogle> {
  const email = options.email ?? 'person@example.test';
  const client = { clientId: 'fake-client.apps.example', clientSecret: 'fake-client-secret' };
  const granted = (options.grant ?? GOOGLE_SIGN_IN_SCOPE.split(' ')).join(' ');
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const access = new Map<string, string>();
  const refresh = new Set<string>();
  const inbox: Stored[] = [];
  const state = {
    authorizeRequests: [] as URLSearchParams[],
    tokenRequests: [] as URLSearchParams[],
    issued: [] as string[],
    sent: [] as Stored[],
    events: new Map<string, Event>(),
  };
  let serial = 0;
  const nextId = () => (0x18c000000000 + ++serial).toString(16);
  const token = (prefix: string) => {
    const value = `${prefix}-${randomBytes(12).toString('hex')}`;
    state.issued.push(value);
    return value;
  };
  const idToken = () => {
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${part({ alg: 'none' })}.${part({
      iss: 'https://accounts.google.com',
      aud: options.idTokenAudience ?? client.clientId,
      email,
      email_verified: true,
    })}.`;
  };
  const tokenAnswer = (withRefresh: boolean) => {
    const accessToken = token('ya29');
    access.set(accessToken, granted);
    const refreshToken = withRefresh ? token('1//refresh') : undefined;
    if (refreshToken) refresh.add(refreshToken);
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3599,
      scope: granted,
      ...(refreshToken ? { refresh_token: refreshToken, id_token: idToken() } : {}),
    };
  };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request): Promise<Response> => {
      const url = new URL(request.url);
      const at = url.pathname;
      if (at === '/o/oauth2/v2/auth') {
        // Stands in for the person at Google's consent screen.
        state.authorizeRequests.push(url.searchParams);
        const back = new URL(url.searchParams.get('redirect_uri') ?? '');
        back.searchParams.set('state', url.searchParams.get('state') ?? '');
        if (options.decline) back.searchParams.set('error', 'access_denied');
        else {
          const code = `4/${randomBytes(12).toString('hex')}`;
          codes.set(code, {
            challenge: url.searchParams.get('code_challenge') ?? '',
            redirectUri: url.searchParams.get('redirect_uri') ?? '',
          });
          back.searchParams.set('code', code);
          back.searchParams.set('scope', granted);
        }
        return new Response(null, { status: 302, headers: { location: back.href } });
      }
      if (at === '/token' && request.method === 'POST') {
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
          if (
            options.refreshRefused ||
            !clientOk ||
            !refresh.has(fields.get('refresh_token') ?? '')
          )
            return Response.json({ error: 'invalid_grant' }, { status: 400 });
          return Response.json(tokenAnswer(false));
        }
        return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
      }
      if (at === '/revoke') return new Response(null, { status: 200 });

      const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      const scopes = access.get(bearer);
      if (scopes === undefined) return Response.json({ error: { code: 401 } }, { status: 401 });
      const needs = (scope: string) =>
        scopes.split(' ').includes(scope)
          ? null
          : Response.json(
              { error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } },
              { status: 403 },
            );

      const gmail = '/gmail/v1/users/me';
      if (at.startsWith(gmail)) {
        const rest = at.slice(gmail.length);
        if (rest === '/messages/send' && request.method === 'POST') {
          const refused = needs(GOOGLE_SCOPES.mailSend);
          if (refused) return refused;
          const body = (await request.json()) as { raw: string };
          let raw = Buffer.from(body.raw, 'base64url');
          if (options.rewriteMessageId)
            raw = Buffer.from(
              raw
                .toString('utf8')
                .replace(/^Message-ID:.*$/im, `Message-ID: <${nextId()}@mail.gmail.com>`),
            );
          const stored = { id: nextId(), raw, labels: ['SENT'] };
          state.sent.push(stored);
          return Response.json({ id: stored.id, threadId: stored.id, labelIds: stored.labels });
        }
        const refused = needs(GOOGLE_SCOPES.mailRead);
        if (refused) return refused;
        if (rest === '/profile') return Response.json({ emailAddress: email });
        if (rest === '/messages') {
          const q = url.searchParams.get('q') ?? '';
          const byId = /^in:sent rfc822msgid:(\S+)$/.exec(q);
          const pool = byId
            ? state.sent.filter((m) => headerOf(m.raw, 'Message-ID') === `<${byId[1]}>`)
            : url.searchParams.get('labelIds') === 'SENT'
              ? state.sent
              : inbox.filter(
                  (m) => !q || m.raw.toString('utf8').toLowerCase().includes(q.toLowerCase()),
                );
          const limit = Number(url.searchParams.get('maxResults') ?? 100);
          const newest = [...pool].reverse().slice(0, limit);
          return Response.json(
            newest.length ? { messages: newest.map((m) => ({ id: m.id, threadId: m.id })) } : {},
          );
        }
        const one = /^\/messages\/([^/]+)$/.exec(rest);
        if (one) {
          const found = [...inbox, ...state.sent].find((m) => m.id === one[1]);
          if (!found) return Response.json({ error: { code: 404 } }, { status: 404 });
          if (url.searchParams.get('format') === 'metadata') {
            const wanted = url.searchParams.getAll('metadataHeaders');
            return Response.json({
              id: found.id,
              labelIds: found.labels,
              payload: {
                headers: wanted
                  .map((name) => ({ name, value: headerOf(found.raw, name) }))
                  .filter((header) => header.value !== undefined),
              },
            });
          }
          return Response.json({
            id: found.id,
            labelIds: found.labels,
            sizeEstimate: found.raw.length,
            raw: found.raw.toString('base64url'),
          });
        }
      }

      const calendar = '/calendar/v3/calendars/primary';
      if (at.startsWith(calendar)) {
        const refused = needs(GOOGLE_SCOPES.calendar);
        if (refused) return refused;
        const rest = at.slice(calendar.length);
        if (rest === '/events' && request.method === 'GET')
          return Response.json({ items: [...state.events.values()] });
        if (rest === '/events' && request.method === 'POST') {
          const body = (await request.json()) as Record<string, unknown>;
          const id = String(body.id ?? nextId());
          if (state.events.has(id)) return Response.json({ error: { code: 409 } }, { status: 409 });
          const event: Event = { ...body, id, etag: '"1"', status: 'confirmed' };
          state.events.set(id, event);
          return Response.json(event);
        }
        const one = /^\/events\/([^/]+)$/.exec(rest);
        if (one) {
          const event = state.events.get(one[1] ?? '');
          if (!event || event.status === 'cancelled')
            return Response.json({ error: { code: 404 } }, { status: 404 });
          if (request.method === 'GET') return Response.json(event);
          if (request.headers.get('if-match') !== event.etag)
            return Response.json({ error: { code: 412 } }, { status: 412 });
          if (request.method === 'DELETE') {
            event.status = 'cancelled';
            return new Response(null, { status: 204 });
          }
          if (request.method === 'PUT') {
            const body = (await request.json()) as Record<string, unknown>;
            const next: Event = {
              ...body,
              id: event.id,
              status: 'confirmed',
              etag: `"${Number(event.etag.replaceAll('"', '')) + 1}"`,
            };
            state.events.set(event.id, next);
            return Response.json(next);
          }
        }
      }
      return new Response('not found', { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return {
    endpoints: {
      authorize: `${origin}/o/oauth2/v2/auth`,
      token: `${origin}/token`,
      revoke: `${origin}/revoke`,
      gmail: `${origin}/gmail/v1/users/me`,
      calendar: `${origin}/calendar/v3/calendars/primary`,
    },
    client,
    ...state,
    deliver(raw: string) {
      const stored = {
        id: nextId(),
        raw: Buffer.from(raw.replace(/\r?\n/g, '\r\n')),
        labels: ['INBOX'],
      };
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
