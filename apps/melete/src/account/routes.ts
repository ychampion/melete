/**
 * A person's whole account: taking everything with them, and deleting it.
 *
 * - `GET /account/export` streams one zip of everything the account holds
 *   (see `export.ts`).
 * - `GET /account/removal/preview` and `DELETE /account` delete the account
 *   (see `removal.ts`); the email is typed to confirm.
 * - The account that set Melete up lists the accounts with `GET /principals`
 *   and deletes one it made with `DELETE /principals/:id`, after
 *   `GET /principals/:id/removal/preview`, and follows it with
 *   `GET /principals/:id/removal`.
 *
 * Every route needs a session, which the principal guard has already checked.
 */
import { accountRemoval, accountRemovalPreview, deleteAccountRequest } from '@melete/contracts';
import type { Hono } from 'hono';
import { deleteCookie } from 'hono/cookie';
import { SESSION_COOKIE } from '../api/auth.ts';
import { type AccountExportDeps, accountExport } from './export.ts';
import type { AccountRemovalService } from './removal.ts';
import { zipStream } from './zip.ts';

export type AccountRoutes = AccountExportDeps & { accounts?: AccountRemovalService };

export function mountAccount(app: Hono, deps: AccountRoutes): void {
  app.get('/account/export', (c) => {
    const day = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
    return new Response(zipStream(accountExport(deps, c.get('owner').id)), {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="melete-export-${day}.zip"`,
        'cache-control': 'no-store',
      },
    });
  });

  const accounts = deps.accounts;
  if (!accounts) return;

  app.get('/account/removal/preview', async (c) => {
    const actor = c.get('owner').id;
    return c.json({ preview: accountRemovalPreview.parse(await accounts.preview(actor, actor)) });
  });

  app.delete('/account', async (c) => {
    const request = deleteAccountRequest.parse(await c.req.json());
    const actor = c.get('owner').id;
    const removal = await accounts.remove(actor, actor, request.confirm_email);
    // The session went with the account; the browser forgets its cookie too.
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ removal: accountRemoval.parse(removal) }, 202);
  });

  app.get('/principals', async (c) => c.json({ accounts: await accounts.list(c.get('owner').id) }));

  app.get('/principals/:id/removal/preview', async (c) =>
    c.json({
      preview: accountRemovalPreview.parse(
        await accounts.preview(c.get('owner').id, c.req.param('id')),
      ),
    }),
  );

  app.get('/principals/:id/removal', async (c) => {
    await accounts.list(c.get('owner').id);
    return c.json({ removal: accountRemoval.parse(await accounts.status(c.req.param('id'))) });
  });

  app.delete('/principals/:id', async (c) => {
    const request = deleteAccountRequest.parse(await c.req.json());
    const removal = await accounts.remove(
      c.get('owner').id,
      c.req.param('id'),
      request.confirm_email,
    );
    return c.json({ removal: accountRemoval.parse(removal) }, 202);
  });
}
