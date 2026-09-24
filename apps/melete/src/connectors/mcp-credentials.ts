import type { Sql } from 'postgres';
import { z } from 'zod';
import { ConnectorFaultError } from './faults.ts';
import type { SealedSecretStore } from './secrets.ts';

/** Credentials only travel over TLS, except an explicit loopback fixture endpoint. */
export const mcpCredentialUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    !url.username &&
    !url.password &&
    !url.hash &&
    (url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
  );
});

export const mcpCredentials = z
  .object({
    access_token: z
      .string()
      .min(1)
      .max(16_384)
      .regex(/^[A-Za-z0-9\-._~+/]+=*$/),
    expires_at: z.iso.datetime().optional(),
    refresh_token: z.string().min(1).max(16_384).optional(),
    token_url: mcpCredentialUrl.optional(),
    client_id: z.string().min(1).max(1024).optional(),
    client_secret: z.string().min(1).max(16_384).optional(),
    status: z.enum(['active', 'revoked']).default('active'),
  })
  .strict()
  .refine(
    (value) => Boolean(value.refresh_token) === Boolean(value.token_url),
    'A refresh token needs its operator-configured token endpoint',
  );

type Credential = z.infer<typeof mcpCredentials>;
const revoked = () =>
  new ConnectorFaultError({
    kind: 'revoked_credential',
    detail: 'MCP credential is no longer available',
  });

/** A refresh rotates sealed bytes, never the operator's scopes, principal or connection identity. */
export function mcpCredentialAccess(
  sql: Sql,
  store: SealedSecretStore,
  binding: { connectionId: string; spaceId: string },
  resource?: string,
  /** How the refresh is sent. The connector supplies the public-only fetch where it must. */
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
) {
  let refreshing: Promise<boolean> | undefined;
  async function read() {
    const [row] = await sql`select secret_ref, generation, scopes, status from connection
      where id = ${binding.connectionId} and space_id = ${binding.spaceId} and provider = 'mcp'`;
    if (!row) throw revoked();
    if (!row.secret_ref) return { row, credential: undefined };
    try {
      const credential = await store.withSecret(row.secret_ref, binding.spaceId, async (value) =>
        mcpCredentials.parse(JSON.parse(value)),
      );
      if (credential.status === 'revoked') throw revoked();
      return { row, credential };
    } catch {
      throw revoked();
    }
  }
  return {
    async accessToken() {
      return (await read()).credential?.access_token;
    },
    async checkCredential() {
      const { credential } = await read();
      if (credential?.expires_at && Date.parse(credential.expires_at) <= Date.now())
        throw new ConnectorFaultError({
          kind: 'expired_credential',
          detail: 'MCP credential expired',
        });
    },
    async refresh(): Promise<boolean> {
      refreshing ??= (async () => {
        const { row, credential } = await read();
        if (row.status !== 'active' || !credential?.refresh_token || !credential.token_url)
          return false;
        const form = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: credential.refresh_token,
          ...(resource ? { resource } : {}),
          ...(credential.client_id ? { client_id: credential.client_id } : {}),
          ...(credential.client_secret ? { client_secret: credential.client_secret } : {}),
        });
        const response = await fetcher(credential.token_url, {
          method: 'POST',
          redirect: 'error',
          keepalive: false,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok || !response.body) {
          await response.body?.cancel().catch(() => {});
          return false;
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 65_536) return false;
            chunks.push(chunk.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        const token = z
          .object({
            access_token: mcpCredentials.shape.access_token,
            token_type: z.string().refine((value) => value.toLowerCase() === 'bearer'),
            expires_in: z.number().int().positive().max(31_536_000).optional(),
            refresh_token: mcpCredentials.shape.refresh_token,
          })
          .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        const next: Credential = {
          ...credential,
          access_token: token.access_token,
          refresh_token: token.refresh_token ?? credential.refresh_token,
          expires_at: token.expires_in
            ? new Date(Date.now() + token.expires_in * 1000).toISOString()
            : undefined,
        };
        const secret = await store.put(binding.spaceId, JSON.stringify(next));
        const changed = await sql`update connection set secret_ref = ${secret}
          where id = ${binding.connectionId} and space_id = ${binding.spaceId}
            and provider = 'mcp' and status = 'active' and generation = ${row.generation}
            and secret_ref = ${row.secret_ref} and scopes = ${JSON.stringify(row.scopes)}::jsonb
          returning id`;
        return changed.length === 1;
      })()
        .catch(() => false)
        .finally(() => {
          refreshing = undefined;
        });
      return refreshing;
    },
  };
}
