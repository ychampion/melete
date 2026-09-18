/**
 * The sites a space is signed in to. One Chromium profile holds the space's cookies, so a "site
 * profile" is a record over that one profile: a registrable domain and when it was last used,
 * never what the person did there. Signing out of a site removes its cookies and storage from
 * the profile and the record with them.
 */
import { rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { type BrowserSite, browserSiteForgotten, browserSiteList } from '@melete/contracts';
import type { Hono } from 'hono';
import type { Sql } from 'postgres';
import { ServiceError } from '../../api/errors.ts';
import { siteOf } from './live-protocol.ts';
import type { BrowserWorkers } from './routes.ts';
import { BrowserFault } from './sessions.ts';

type SiteRow = { domain: string; label: string; last_used: string | Date };

/**
 * The one directory a space's browser owns, or a refusal. The id is the only part a caller
 * supplies, so it is held to the shape a space id has and the result is held inside the root:
 * `rm` with `force` is silent, and a silent removal outside the spaces root is the worst kind.
 */
export function confinedSpaceProfile(spacesRoot: string, spaceId: string): string {
  if (!/^sp_[A-Za-z0-9_-]+$/.test(spaceId)) throw new BrowserFault('invalid_space');
  const root = resolve(spacesRoot);
  const profile = resolve(root, spaceId, 'browser');
  if (!profile.startsWith(root + sep)) throw new BrowserFault('profile_outside_space');
  return profile;
}

/** What a space kept in its browser, and what became of it. `profile` is the directory removed. */
export type ForgottenBrowserProfiles = {
  space_id: string;
  profile: string | null;
  rows: number;
};

export class BrowserSiteService {
  constructor(
    private readonly sql: Sql,
    private readonly workers: BrowserWorkers,
  ) {}

  /** Recorded when a takeover ends on a site whose cookies the profile now holds. */
  async record(spaceId: string, domain: string): Promise<void> {
    const site = siteOf(domain);
    await this.sql`insert into browser_site_profile (space_id, domain, label)
      values (${spaceId}, ${site}, ${site})
      on conflict (space_id, domain) do update set last_used = now()`;
  }

  async list(spaceId: string, principalId?: string): Promise<BrowserSite[]> {
    await this.owned(spaceId, principalId);
    const rows = await this.sql<SiteRow[]>`select domain, label, last_used
      from browser_site_profile where space_id = ${spaceId}
      order by last_used desc, domain limit 100`;
    return rows.map((row) => ({
      domain: row.domain,
      label: row.label,
      last_used: new Date(row.last_used).toISOString(),
    }));
  }

  /** The record goes only once the worker has cleared the profile, so nothing is lost silently. */
  async forget(spaceId: string, domain: string, principalId?: string) {
    await this.owned(spaceId, principalId);
    const site = siteOf(domain);
    // Only a registrable domain exactly as it was listed: not a sub-host, not a URL, not a port.
    let host: string;
    try {
      host = new URL(`http://${domain}/`).hostname;
    } catch {
      throw new BrowserFault('invalid_domain');
    }
    if (host !== domain.toLowerCase() || site !== host) throw new BrowserFault('invalid_domain');
    const worker = await this.workers.get(spaceId);
    await worker.forgetSite(site);
    await this.sql`delete from browser_site_profile
      where space_id = ${spaceId} and domain = ${site}`;
    return { domain: site, forgotten: true as const };
  }

  /**
   * Everything this space's browser holds, gone: its worker stopped, its Chromium profile removed
   * from the space directory, and its records deleted. Whoever deletes a space calls this before
   * deleting the space row, because a running worker holds the profile open and would write files
   * back under a root the caller believes is already gone. Deleting the space row alone takes the
   * records with it, since they reference the space, but never the profile on disk. Calling it
   * for a space with no worker running and no profile is silent and safe.
   */
  async forgetSpace(spaceId: string): Promise<ForgottenBrowserProfiles> {
    const root = this.workers.spacesRoot;
    // A directory is removed here, so the space names one inside the spaces root or none at all.
    const profile = root === undefined ? null : confinedSpaceProfile(root, spaceId);
    // Nothing is removed while a worker may still be writing to it; where a worker cannot be
    // stopped, nothing is removed at all.
    if (profile && !this.workers.release) throw new BrowserFault('worker_release_unavailable');
    await this.workers.release?.(spaceId);
    if (profile) await rm(profile, { recursive: true, force: true });
    const removed = await this.sql`delete from browser_site_profile
      where space_id = ${spaceId}`;
    return { space_id: spaceId, profile, rows: removed.count };
  }

  /** Signed-in sites belong to whoever owns the space, even where others may work in it. */
  private async owned(spaceId: string, principalId?: string): Promise<void> {
    if (!principalId) return;
    const [owned] = await this.sql`select 1 from space s where s.id = ${spaceId}
      and coalesce(s.owner_principal_id, (select id from owner limit 1)) = ${principalId}`;
    if (!owned) throw new BrowserFault('space_not_found');
  }
}

/**
 * The one call a space-deletion sweep makes for the browser, before it deletes the space row.
 *
 * It stops that space's worker, removes the space's Chromium profile directory — cookies, storage
 * and all — and deletes the sites recorded over it. Order matters in one direction: a running
 * worker holds the profile open, so this must finish before the space root or the space row goes.
 * The space root itself is the caller's to remove; only the browser's directory inside it goes
 * here. Calling it twice, or for a space that never opened a browser, does nothing and says so.
 *
 * `browser` is the service's `browserSessions`, which is absent on a deployment with no browser
 * worker; then there is no profile and no worker, and the rows — if an earlier configuration left
 * any — follow the space row by cascade.
 */
export async function forgetBrowserProfilesForSpace(
  browser: { sites: BrowserSiteService } | undefined,
  spaceId: string,
): Promise<ForgottenBrowserProfiles> {
  if (!browser) return { space_id: spaceId, profile: null, rows: 0 };
  return browser.sites.forgetSpace(spaceId);
}

function refused(error: unknown): never {
  if (error instanceof BrowserFault)
    throw new ServiceError(
      error.reason,
      `The signed-in sites of this space could not be reached: ${error.reason}.`,
      error.reason === 'space_not_found' ? 404 : error.reason === 'invalid_domain' ? 400 : 409,
    );
  throw error;
}

/** Mounted after the existing owner session and same-origin middleware. */
export function mountBrowserSites(app: Hono, sites: BrowserSiteService) {
  app.get('/browser/sites', async (c) => {
    const listed = await sites
      .list(c.get('experienceSpaceId'), c.get('owner').id)
      .catch((error: unknown) => refused(error));
    return c.json(browserSiteList.parse({ sites: listed }));
  });
  app.delete('/browser/sites/:domain', async (c) => {
    const forgotten = await sites
      .forget(c.get('experienceSpaceId'), c.req.param('domain') ?? '', c.get('owner').id)
      .catch((error: unknown) => refused(error));
    return c.json(browserSiteForgotten.parse(forgotten));
  });
}
