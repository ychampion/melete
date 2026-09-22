/**
 * A loopback OAuth issuer shaped like ChatGPT's, for tests only. It checks
 * PKCE on every code exchange, rotates refresh tokens and refuses a reused one
 * the way auth.openai.com does, and records what it was asked so a test can
 * count refreshes and revocations. No real provider is ever contacted.
 */
import { createHash, randomBytes } from 'node:crypto';

const jwt = (claims: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

export interface FakeIssuer {
  url: string;
  /** Seconds each access token lives. */
  lifetime: number;
  refreshCount: number;
  refreshDelayMs: number;
  /** The status the token endpoint answers a refresh with instead of refreshing. */
  refreshFailure: { status: number; body: unknown } | null;
  revoked: { token: string; hint: string }[];
  exchanges: number;
  devicePolls: number;
  approveDevice(): void;
  /** Invalidates every refresh token issued so far, as a revocation at the provider would. */
  revokeAll(): void;
  /** Every token this issuer has handed out, to search output for. */
  issued: string[];
  stop(): Promise<void>;
}

export async function startFakeIssuer(): Promise<FakeIssuer> {
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>();
  const refresh = new Map<string, 'live' | 'used' | 'revoked'>();
  let deviceApproved = false;
  const device = { id: 'device-auth-fixture', userCode: 'ABCD-1234' };
  let serial = 0;
  const state: Omit<FakeIssuer, 'url' | 'stop'> = {
    lifetime: 3600,
    refreshCount: 0,
    refreshDelayMs: 0,
    refreshFailure: null,
    revoked: [],
    exchanges: 0,
    devicePolls: 0,
    approveDevice: () => {
      deviceApproved = true;
    },
    revokeAll: () => {
      for (const token of refresh.keys()) refresh.set(token, 'revoked');
    },
    issued: [],
  };

  const pair = () => {
    serial++;
    const access = jwt({ exp: Math.floor(Date.now() / 1000) + state.lifetime, n: serial });
    const next = `refresh-${serial}-${randomBytes(8).toString('hex')}`;
    const id = jwt({
      email: 'owner@example.test',
      'https://api.openai.com/auth': { chatgpt_account_id: 'account-fixture' },
    });
    refresh.set(next, 'live');
    state.issued.push(access, next);
    return {
      access_token: access,
      refresh_token: next,
      id_token: id,
      token_type: 'Bearer',
      expires_in: state.lifetime,
    };
  };

  const issue = (redirectUri: string, challenge: string, clientId: string) => {
    const code = `code-${randomBytes(12).toString('hex')}`;
    codes.set(code, { challenge, redirectUri, clientId });
    state.issued.push(code);
    return code;
  };

  const body = async (request: Request): Promise<Record<string, string>> => {
    const text = await request.text();
    if ((request.headers.get('content-type') ?? '').includes('application/json'))
      return JSON.parse(text) as Record<string, string>;
    return Object.fromEntries(new URLSearchParams(text));
  };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/oauth/authorize') {
        // Stands in for the person approving in their browser.
        const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
        if (url.searchParams.get('code_challenge_method') !== 'S256')
          return new Response('pkce required', { status: 400 });
        redirect.searchParams.set(
          'code',
          issue(
            redirect.href,
            url.searchParams.get('code_challenge') ?? '',
            url.searchParams.get('client_id') ?? '',
          ),
        );
        redirect.searchParams.set('state', url.searchParams.get('state') ?? '');
        return new Response(null, { status: 302, headers: { location: redirect.href } });
      }
      if (url.pathname === '/oauth/token') {
        const fields = await body(request);
        if (fields.grant_type === 'authorization_code') {
          state.exchanges++;
          const grant = codes.get(fields.code ?? '');
          codes.delete(fields.code ?? '');
          const verified =
            grant &&
            grant.clientId === fields.client_id &&
            grant.redirectUri === fields.redirect_uri &&
            createHash('sha256')
              .update(fields.code_verifier ?? '')
              .digest('base64url') === grant.challenge;
          if (!verified) return Response.json({ error: 'invalid_grant' }, { status: 400 });
          return Response.json(pair());
        }
        if (fields.grant_type === 'refresh_token') {
          state.refreshCount++;
          if (state.refreshDelayMs) await Bun.sleep(state.refreshDelayMs);
          if (state.refreshFailure)
            return Response.json(state.refreshFailure.body, {
              status: state.refreshFailure.status,
            });
          const token = fields.refresh_token ?? '';
          const found = refresh.get(token);
          if (found !== 'live')
            return Response.json(
              {
                error: {
                  code: found === 'used' ? 'refresh_token_reused' : 'refresh_token_invalidated',
                  message: `refresh token ${token} is not valid`,
                },
              },
              { status: 401 },
            );
          refresh.set(token, 'used');
          return Response.json(pair());
        }
        return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
      }
      if (url.pathname === '/oauth/revoke') {
        const fields = await body(request);
        state.revoked.push({ token: fields.token ?? '', hint: fields.token_type_hint ?? '' });
        if (refresh.has(fields.token ?? '')) refresh.set(fields.token ?? '', 'revoked');
        return new Response(null, { status: 200 });
      }
      if (url.pathname === '/api/accounts/deviceauth/usercode')
        return Response.json({
          device_auth_id: device.id,
          user_code: device.userCode,
          interval: '1',
        });
      if (url.pathname === '/api/accounts/deviceauth/token') {
        state.devicePolls++;
        const fields = await body(request);
        if (fields.device_auth_id !== device.id || fields.user_code !== device.userCode)
          return new Response(null, { status: 400 });
        if (!deviceApproved) return new Response(null, { status: 403 });
        const verifier = randomBytes(64).toString('base64url');
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        return Response.json({
          authorization_code: issue(
            `${origin}/deviceauth/callback`,
            challenge,
            'app_EMoamEEZ73f0CkXaXp7hrann',
          ),
          code_verifier: verifier,
          code_challenge: challenge,
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const fake = state as FakeIssuer;
  fake.url = origin;
  fake.stop = async () => {
    await server.stop(true);
  };
  return fake;
}
