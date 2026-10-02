/**
 * Apps, served the way the service serves them: a list, one app with its
 * versions and grants for a manager, a view for the person asking, and the
 * view's files with the same isolation headers the service sets.
 *
 * Two apps are seeded: Deals, which the signed-in person published and
 * manages, with three versions; and a team tracker someone else shared with
 * them. Deals reads its data through the bridge, which this mock answers at
 * `GET /apps/{id}/data/{name}` with a fixed list.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  type AppDetail,
  type AppManifest,
  type AppSummary,
  appCurrentRequest,
  appDeleted,
  appDetail,
  appGrantsRequest,
  appListResponse,
  appView,
} from '@melete/contracts';
import type { Hono } from 'hono';
import { VIEW_POLICY, viewHeaders } from '../../melete/src/viewer/headers.ts';
import type { AppDeps } from './app.ts';

const ME = { id: 'own_01M0000000000000000000000A', email: 'you@example.test' };
const SAM = { id: 'own_01M0000000000000000000000B', email: 'sam@example.test' };

/** The bridge client an app bundles, as the build-an-app skill describes it. */
const CLIENT = `const melete = (() => {
  let next = 0;
  const waiting = new Map();
  addEventListener('message', (event) => {
    const reply = event.data;
    if (event.source !== parent || !reply || reply.type !== 'melete.reply') return;
    const settle = waiting.get(reply.id);
    if (!settle) return;
    waiting.delete(reply.id);
    reply.ok ? settle[0](reply.value) : settle[1](new Error(reply.error));
  });
  const ask = (message) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      waiting.set(id, [resolve, reject]);
      parent.postMessage({ ...message, id }, '*');
    });
  return {
    data: (name) => ask({ type: 'melete.data', name }),
    submit: (collection, record) => ask({ type: 'melete.submit', collection, record }),
    link: (url) => parent.postMessage({ type: 'melete.link', url }, '*'),
    size: (height) => parent.postMessage({ type: 'melete.size', height }, '*'),
  };
})();
`;

const DEALS_HTML = (title: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="style.css"></head>
<body><main><h1>${title}</h1><p id="status">Loading deals…</p>
<table><thead><tr><th>Company</th><th>Stage</th><th>Value</th></tr></thead><tbody id="rows"></tbody></table>
<p><button id="crm" type="button">Open the CRM</button></p></main>
<script src="melete-app.js"></script><script src="app.js"></script></body></html>
`;

const DEALS_JS = `melete.data('deals').then((deals) => {
  const rows = document.getElementById('rows');
  for (const deal of deals) {
    const row = document.createElement('tr');
    for (const value of [deal.company, deal.stage, '$' + deal.value.toLocaleString('en-US')]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    rows.append(row);
  }
  document.getElementById('status').textContent = deals.length + ' open deals';
}).catch((error) => { document.getElementById('status').textContent = error.message; });
document.getElementById('crm').addEventListener('click', () => melete.link('https://example.com/crm'));
`;

const DEALS_CSS = `body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 24px; color: #1d1b16; }
h1 { font-size: 22px; margin: 0 0 4px; }
table { border-collapse: collapse; width: 100%; max-width: 640px; margin-top: 12px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e6e1d6; }
button { font: inherit; padding: 6px 12px; border-radius: 8px; border: 1px solid #c9c2b4; background: #fff; }
`;

const TRACKER_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Team tracker</title>
<style>body{font:15px/1.5 system-ui,sans-serif;padding:24px;margin:0}li{margin:6px 0}</style></head>
<body><h1>Team tracker</h1><ul><li>Hiring plan: in review</li><li>Q4 budget: done</li><li>Offsite: booked</li></ul></body></html>
`;

const DEALS_DATA = [
  { company: 'Acme', stage: 'Proposal', value: 12000 },
  { company: 'Globex', stage: 'Negotiation', value: 48000 },
  { company: 'Initech', stage: 'Discovery', value: 7500 },
];

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
};

type Version = {
  id: string;
  manifest: AppManifest;
  bytes: Record<string, string>;
  created_at: string;
  created_by: typeof ME;
};

type MockApp = {
  summary: Omit<AppSummary, 'current_version'>;
  versions: Version[];
  current: string;
  grants: NonNullable<AppDetail['grants']>;
  generation: number;
};

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function version(appId: string, files: Record<string, string>, at: string, by = ME): Version {
  const manifest: AppManifest = {
    entry: 'index.html',
    files: Object.fromEntries(
      Object.entries(files).map(([path, text]) => [
        path,
        {
          sha256: sha(text),
          size: Buffer.byteLength(text),
          mime: TYPES[path.split('.').at(-1) ?? ''] ?? 'text/plain; charset=utf-8',
        },
      ]),
    ),
    data: {},
    collections: {},
  };
  return {
    id: sha(`${appId}\n${JSON.stringify(manifest)}`),
    manifest,
    bytes: files,
    created_at: at,
    created_by: by,
  };
}

function changes(before: AppManifest | null, after: AppManifest) {
  const old = before?.files ?? {};
  return {
    added: Object.keys(after.files).filter((path) => !old[path]),
    removed: Object.keys(old).filter((path) => !after.files[path]),
    changed: Object.keys(after.files).filter(
      (path) => old[path] && old[path].sha256 !== after.files[path]?.sha256,
    ),
    truncated: false,
  };
}

export function mountAppsMock(app: Hono, deps: AppDeps): void {
  const now = () => deps.store.now();
  const ago = (days: number) => new Date(now().getTime() - days * 86_400_000).toISOString();
  const apps = new Map<string, MockApp>();
  const views = new Map<string, { appId: string; version: string; generation: number }>();

  if (deps.seedExperience) {
    const dealsId = 'app_deals0000000000000000000000001';
    const dealsVersions = [
      version(
        dealsId,
        { 'index.html': DEALS_HTML('Deals'), 'melete-app.js': CLIENT, 'app.js': DEALS_JS },
        ago(9),
      ),
      version(
        dealsId,
        {
          'index.html': DEALS_HTML('Deals'),
          'melete-app.js': CLIENT,
          'app.js': DEALS_JS,
          'style.css': DEALS_CSS,
        },
        ago(4),
      ),
      version(
        dealsId,
        {
          'index.html': DEALS_HTML('Open deals'),
          'melete-app.js': CLIENT,
          'app.js': DEALS_JS,
          'style.css': DEALS_CSS,
        },
        ago(0.2),
      ),
    ];
    for (const v of dealsVersions)
      v.manifest.data = {
        deals: {
          kind: 'artifact',
          path: 'data/deals.json',
          source_job_id: 'job_01M0000000000000000000000A',
        },
      };
    apps.set(dealsId, {
      summary: {
        id: dealsId,
        name: 'Deals',
        description: 'Open deals by stage',
        publisher: ME,
        role: 'manage',
        created_at: ago(9),
        updated_at: ago(0.2),
      },
      versions: dealsVersions,
      current: dealsVersions[2]?.id ?? '',
      grants: [{ kind: 'principal', principal: SAM, role: 'view', granted_at: ago(4) }],
      generation: 1,
    });
    const trackerId = 'app_tracker00000000000000000000001';
    const tracker = version(trackerId, { 'index.html': TRACKER_HTML }, ago(2), SAM);
    apps.set(trackerId, {
      summary: {
        id: trackerId,
        name: 'Team tracker',
        description: null,
        publisher: SAM,
        role: 'view',
        created_at: ago(2),
        updated_at: ago(2),
      },
      versions: [tracker],
      current: tracker.id,
      grants: [],
      generation: 0,
    });
  }

  const summary = (entry: MockApp): AppSummary => {
    const current = entry.versions.find((v) => v.id === entry.current);
    return {
      ...entry.summary,
      current_version: current
        ? {
            id: current.id,
            created_at: current.created_at,
            created_by: current.created_by,
            file_count: Object.keys(current.manifest.files).length,
            total_bytes: Object.values(current.manifest.files).reduce((sum, f) => sum + f.size, 0),
          }
        : null,
    };
  };

  const detail = (entry: MockApp): AppDetail => {
    const current = entry.versions.find((v) => v.id === entry.current) ?? entry.versions[0];
    const manager = entry.summary.role === 'manage';
    return appDetail.parse({
      app: summary(entry),
      files: Object.entries(current?.manifest.files ?? {}).map(([path, file]) => ({
        path,
        size: file.size,
        mime: file.mime,
      })),
      data: Object.entries(current?.manifest.data ?? {}).map(([name, binding]) => ({
        name,
        kind: binding.kind,
        path: binding.path,
      })),
      collections: [],
      versions: manager
        ? entry.versions
            .map((v, index) => ({
              id: v.id,
              created_at: v.created_at,
              created_by: v.created_by,
              file_count: Object.keys(v.manifest.files).length,
              total_bytes: Object.values(v.manifest.files).reduce((sum, f) => sum + f.size, 0),
              current: v.id === entry.current,
              changes: changes(entry.versions[index - 1]?.manifest ?? null, v.manifest),
            }))
            .reverse()
        : null,
      grants: manager ? entry.grants : null,
    });
  };

  const missing = () =>
    Response.json({ error: { code: 'not_found', message: 'No such app.' } }, { status: 404 });

  app.get('/apps', () =>
    Response.json(appListResponse.parse({ apps: [...apps.values()].map(summary) })),
  );

  app.get('/apps/:id', (c) => {
    const entry = apps.get(c.req.param('id'));
    return entry ? Response.json(detail(entry)) : missing();
  });

  app.post('/apps/:id/views', (c) => {
    const entry = apps.get(c.req.param('id'));
    if (!entry) return missing();
    const token = randomBytes(24).toString('base64url');
    views.set(token, {
      appId: entry.summary.id,
      version: entry.current,
      generation: entry.generation,
    });
    return Response.json(
      appView.parse({
        view_path: `/apps/view/${token}/index.html`,
        version_id: entry.current,
        expires_at: new Date(now().getTime() + 15 * 60_000).toISOString(),
      }),
    );
  });

  app.post('/apps/:id/current', async (c) => {
    const entry = apps.get(c.req.param('id'));
    if (!entry) return missing();
    const input = appCurrentRequest.safeParse(await c.req.json().catch(() => null));
    if (!input.success || !entry.versions.some((v) => v.id === input.data.version_id))
      return missing();
    entry.current = input.data.version_id;
    entry.summary.updated_at = now().toISOString();
    return Response.json(detail(entry));
  });

  app.put('/apps/:id/grants', async (c) => {
    const entry = apps.get(c.req.param('id'));
    if (!entry) return missing();
    const input = appGrantsRequest.safeParse(await c.req.json().catch(() => null));
    if (!input.success)
      return Response.json(
        { error: { code: 'invalid_request', message: 'Request data is invalid.' } },
        { status: 400 },
      );
    const at = now().toISOString();
    entry.grants = input.data.grants.map((grant) =>
      grant.kind === 'installation'
        ? { kind: 'installation', role: 'view', granted_at: at }
        : {
            kind: 'principal',
            principal: {
              id: `own_${sha(grant.email).slice(0, 26).toUpperCase()}`,
              email: grant.email,
            },
            role: grant.role,
            granted_at: at,
          },
    );
    entry.generation += 1;
    return Response.json(detail(entry));
  });

  app.delete('/apps/:id', (c) => {
    const id = c.req.param('id');
    if (!apps.delete(id)) return missing();
    return Response.json(appDeleted.parse({ id, deleted: true }));
  });

  // The data a binding reads. Deals has one, `deals`.
  app.get('/apps/:id/data/:name', (c) => {
    const entry = apps.get(c.req.param('id'));
    const current = entry?.versions.find((v) => v.id === entry.current);
    if (!current || !(c.req.param('name') in current.manifest.data)) return missing();
    return Response.json(DEALS_DATA);
  });

  app.get('/apps/view/:token/:path{.+}', (c) => {
    const view = views.get(c.req.param('token'));
    const entry = view ? apps.get(view.appId) : undefined;
    const isolatedMissing = () =>
      new Response('{"error":{"code":"not_found","message":"This view has ended."}}', {
        status: 404,
        headers: viewHeaders('application/json'),
      });
    if (!view || !entry || entry.current !== view.version || entry.generation !== view.generation)
      return isolatedMissing();
    const current = entry.versions.find((v) => v.id === entry.current);
    const path = c.req.param('path');
    const file = current?.manifest.files[path];
    const text = current?.bytes[path];
    if (!file || text === undefined) return isolatedMissing();
    const headers = viewHeaders(file.mime);
    // In development the web app runs on its own port, so by default the mock
    // lets any page frame an app. Behind the web server's same-origin proxy,
    // MELETE_MOCK_APP_FRAMES=self keeps the service's exact policy.
    if (process.env.MELETE_MOCK_APP_FRAMES !== 'self')
      headers.set(
        'content-security-policy',
        VIEW_POLICY.replace("frame-ancestors 'self'", 'frame-ancestors *'),
      );
    return new Response(text, { headers });
  });
}
