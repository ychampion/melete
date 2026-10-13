/**
 * Settings → Saved sign-ins: a person's own sign-ins for Melete's browser in
 * the space they are in. Every route answers for the signed-in person alone;
 * another person's sign-ins, even in a space both use, read as absent. No
 * answer carries a saved password or code secret.
 */
import {
  ID_PREFIXES,
  prefixedId,
  savedSignInCheck,
  savedSignInCode,
  savedSignInCreate,
  savedSignInDeleted,
  savedSignInList,
  savedSignInUpdate,
} from '@melete/contracts';
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import { type SignInVault, VaultFault } from '../connectors/sign-in-vault.ts';
import { ServiceError } from './errors.ts';

const STATUS: Record<VaultFault['code'], ContentfulStatusCode> = {
  not_found: 404,
  invalid_site: 400,
  insecure_site: 400,
  invalid_code_secret: 400,
  duplicate: 409,
  no_code: 404,
  key_missing: 503,
  key_changed: 409,
  unreadable: 409,
  changed: 409,
};

function refused(error: unknown): never {
  if (error instanceof VaultFault)
    throw new ServiceError(error.code, error.message, STATUS[error.code]);
  // Anything else is said without its contents: an error from below could name what was sealed.
  throw new ServiceError('sign_in_unavailable', 'Saved sign-ins could not be reached.', 500);
}

/** The person and the space a request speaks for, from the session alone. */
function scopeOf(c: Context): { spaceId: string; principalId: string } {
  const owner = c.get('owner') as { id?: string; kind?: string } | undefined;
  const spaceId = c.get('experienceSpaceId') as string | undefined;
  if (!owner?.id || !spaceId || !prefixedId(ID_PREFIXES.space).safeParse(spaceId).success)
    throw new ServiceError('unauthorized', 'Sign in first.', 401);
  // A guest of a room works there for a while; a password is not left behind for them.
  if (owner.kind === 'guest')
    throw new ServiceError('forbidden', 'A guest cannot keep saved sign-ins.', 403);
  return { spaceId, principalId: owner.id };
}

const idOf = (c: Context) => {
  const id = c.req.param('id') ?? '';
  if (!prefixedId(ID_PREFIXES.saved_sign_in).safeParse(id).success)
    throw new ServiceError('not_found', 'There is no such saved sign-in of yours here.', 404);
  return id;
};

async function bodyOf<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (parsed.success) return parsed.data;
  // Which field is wrong, never the value it held: a password must not be echoed.
  const issue = parsed.error.issues[0];
  const field = issue?.path.map(String).join('.') || 'request';
  throw new ServiceError(
    'invalid_request',
    `Check ${field}: ${issue?.message ?? 'not valid'}.`,
    400,
  );
}

/** Mounted after the session and same-origin middleware. */
export function mountSignIns(app: Hono, vault: SignInVault): void {
  app.get('/sign-ins', async (c) => {
    const scope = scopeOf(c);
    const listed = await vault.list(scope.spaceId, scope.principalId).catch(refused);
    return c.json(savedSignInList.parse({ sign_ins: listed }));
  });

  app.post('/sign-ins', async (c) => {
    const scope = scopeOf(c);
    const body = await bodyOf(c, savedSignInCreate);
    const saved = await vault.create(scope.spaceId, scope.principalId, body).catch(refused);
    return c.json(saved, 201);
  });

  app.patch('/sign-ins/:id', async (c) => {
    const scope = scopeOf(c);
    const id = idOf(c);
    const change = await bodyOf(c, savedSignInUpdate);
    const saved = await vault.update(scope.spaceId, scope.principalId, id, change).catch(refused);
    return c.json(saved);
  });

  app.delete('/sign-ins/:id', async (c) => {
    const scope = scopeOf(c);
    const id = idOf(c);
    await vault.delete(scope.spaceId, scope.principalId, id).catch(refused);
    return c.json(savedSignInDeleted.parse({ id, deleted: true }));
  });

  app.post('/sign-ins/:id/code', async (c) => {
    const scope = scopeOf(c);
    const id = idOf(c);
    const code = await vault.code(scope.spaceId, scope.principalId, id).catch(refused);
    return c.json(savedSignInCode.parse(code));
  });

  app.post('/sign-ins/:id/check', async (c) => {
    const scope = scopeOf(c);
    const id = idOf(c);
    const checked = await vault.check(scope.spaceId, scope.principalId, id).catch(refused);
    return c.json(savedSignInCheck.parse(checked));
  });
}
