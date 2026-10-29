/**
 * The operator console's routes, under `/operator`. Every one answers the
 * installation's owner alone, signed in from a browser:
 *
 * - no session, or one that ended (a disabled or deleted account): 401, from
 *   the session check that runs before every route;
 * - a guest: 403 `guests_use_rooms`, from the same check;
 * - any other account, or the owner's connected assistant acting for them:
 *   403 `owner_required`, from the check below, which runs before each route
 *   reads or changes anything.
 */
import {
  accountRemoval,
  accountRemovalPreview,
  deleteAccountRequest,
  operatorAudit,
  operatorCapsRequest,
  operatorInviteRequest,
  operatorInviteResponse,
  operatorOverview,
  operatorPeople,
  operatorPersonResponse,
  operatorResetResponse,
} from '@melete/contracts';
import type { Context, Hono } from 'hono';
import { ServiceError } from '../api/errors.ts';
import type { OperatorConsole } from './console.ts';
import { DRAIN_PATH } from './drain.ts';

const OWNER_ONLY =
  'Only the owner of this installation can manage people here. Ask them if something needs changing.';

export function mountOperatorConsole(app: Hono, operator: OperatorConsole): void {
  /** The owner, from a browser session, or a refusal before anything is read. */
  app.use('/operator/*', async (c, next) => {
    // The drain answers the operator's token, not a session (drain.ts).
    if (c.req.path === DRAIN_PATH) return next();
    const actor = c.get('owner') as { id?: string; email?: string } | undefined;
    // An assistant's grant acts for its person but holds no browser session:
    // it can do much in their name, but not run the installation.
    const session = c.get('sessionDigest') as string | undefined;
    if (!actor?.id || !actor.email || !session || !(await operator.isOwner(actor.id)))
      throw new ServiceError('owner_required', OWNER_ONLY, 403);
    await next();
  });
  const actor = (c: Context) => {
    const owner = c.get('owner') as { id: string; email: string };
    return { id: owner.id, email: owner.email };
  };

  app.get('/operator/overview', async (c) =>
    c.json(operatorOverview.parse(await operator.overview())),
  );
  app.get('/operator/people', async (c) => c.json(operatorPeople.parse(await operator.people())));
  app.post('/operator/people', async (c) => {
    const input = operatorInviteRequest.parse(await c.req.json());
    return c.json(operatorInviteResponse.parse(await operator.invite(actor(c), input.email)), 201);
  });
  app.post('/operator/people/:id/disable', async (c) =>
    c.json(
      operatorPersonResponse.parse({
        person: await operator.setDisabled(actor(c), c.req.param('id'), true),
      }),
    ),
  );
  app.post('/operator/people/:id/enable', async (c) =>
    c.json(
      operatorPersonResponse.parse({
        person: await operator.setDisabled(actor(c), c.req.param('id'), false),
      }),
    ),
  );
  app.post('/operator/people/:id/password-reset', async (c) =>
    c.json(operatorResetResponse.parse(await operator.sendReset(actor(c), c.req.param('id')))),
  );
  app.put('/operator/people/:id/caps', async (c) => {
    const caps = operatorCapsRequest.parse(await c.req.json());
    return c.json(
      operatorPersonResponse.parse({
        person: await operator.setCaps(actor(c), c.req.param('id'), caps),
      }),
    );
  });
  app.get('/operator/people/:id/removal/preview', async (c) =>
    c.json({
      preview: accountRemovalPreview.parse(
        await operator.removalPreview(actor(c), c.req.param('id')),
      ),
    }),
  );
  app.delete('/operator/people/:id', async (c) => {
    const request = deleteAccountRequest.parse(await c.req.json());
    return c.json(
      {
        removal: accountRemoval.parse(
          await operator.remove(actor(c), c.req.param('id'), request.confirm_email),
        ),
      },
      202,
    );
  });
  app.get('/operator/audit', async (c) =>
    c.json(operatorAudit.parse({ entries: await operator.audit() })),
  );
}
