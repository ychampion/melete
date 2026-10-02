/**
 * Apps, served the way the service serves them: a list, one app with its
 * versions and grants for a manager, a view for the person asking, and the
 * view's files with the same isolation headers the service sets.
 *
 * Two apps are seeded: Deals, which the signed-in person published and
 * manages, with three versions; and a team tracker someone else shared with
 * them. Deals reads its data through the bridge, which this mock answers at
 * `GET /apps/{id}/data/{name}`. Its publisher reviews each new version of
 * that data: one is let through and a newer one waits. Deals also collects
 * feedback, three responses of which are seeded.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  type AppDataUpdate,
  type AppDetail,
  type AppManifest,
  type AppSubmission,
  type AppSummary,
  appCurrentRequest,
  appDataReleaseRequest,
  appDataUpdates,
  appDataValue,
  appDeleted,
  appDetail,
  appGrantsRequest,
  appListResponse,
  appSubmissionAccepted,
  appSubmissionDeleted,
  appSubmissionList,
  appSubmissionRequest,
  appSubmissionsDeleted,
  appView,
  type JsonValue,
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
  const changed = new Set();
  addEventListener('message', (event) => {
    if (event.source === parent && event.data && event.data.type === 'melete.changed')
      for (const listener of changed) listener(event.data.name);
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
    onChange: (listener) => changed.add(listener),
  };
})();
`;

const DEALS_HTML = (title: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="style.css"></head>
<body><main><h1>${title}</h1><p id="status">Loading deals…</p>
<table><thead><tr><th>Company</th><th>Stage</th><th>Value</th></tr></thead><tbody id="rows"></tbody></table>
<p><button id="crm" type="button">Open the CRM</button></p>
<form id="feedback"><label>Feedback <input id="note" name="note" required></label>
<button type="submit">Send</button> <span id="sent"></span></form></main>
<script src="melete-app.js"></script><script src="app.js"></script></body></html>
`;

const DEALS_JS = `const show = () => melete.data('deals').then((deals) => {
  const rows = document.getElementById('rows');
  rows.textContent = '';
  if (!deals) { document.getElementById('status').textContent = 'No deals yet'; return; }
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
show();
melete.onChange((name) => { if (name === 'deals') show(); });
document.getElementById('crm').addEventListener('click', () => melete.link('https://example.com/crm'));
document.getElementById('feedback').addEventListener('submit', (event) => {
  event.preventDefault();
  const note = document.getElementById('note');
  melete.submit('feedback', { note: note.value })
    .then(() => { note.value = ''; document.getElementById('sent').textContent = 'Sent'; })
    .catch((error) => { document.getElementById('sent').textContent = error.message; });
});
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
/** The routine's newer version, waiting for the publisher. */
const DEALS_NEXT = [...DEALS_DATA, { company: 'Umbrella', stage: 'Discovery', value: 9000 }];

/** One recorded version of a data file. */
type DataVersion = { artifact_id: string; value: JsonValue; written_at: string; size: number };

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
  /** By binding name: every version written, oldest first, and the one let through. */
  data: Record<string, { versions: DataVersion[]; released: string | null }>;
  submissions: AppSubmission[];
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
    for (const v of dealsVersions) {
      v.manifest.data = {
        deals: {
          kind: 'artifact',
          path: 'data/deals.json',
          source_job_id: 'job_01M0000000000000000000000A',
          review: true,
        },
      };
      v.manifest.collections = { feedback: { max_bytes: 2048 } };
    }
    const dataVersion = (id: string, value: JsonValue, at: string): DataVersion => ({
      artifact_id: id,
      value,
      written_at: at,
      size: Buffer.byteLength(JSON.stringify(value)),
    });
    const response = (
      n: number,
      by: typeof ME,
      note: string,
      at: string,
      version: string,
    ): AppSubmission => ({
      id: `asub_01M000000000000000000000${String(n).padStart(2, '0')}`,
      collection: 'feedback',
      version_id: version,
      by,
      data: { note },
      created_at: at,
    });
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
      data: {
        deals: {
          versions: [
            dataVersion('art_01M0000000000000000000000A', DEALS_DATA, ago(1)),
            dataVersion('art_01M0000000000000000000000B', DEALS_NEXT, ago(0.1)),
          ],
          released: 'art_01M0000000000000000000000A',
        },
      },
      submissions: [
        response(3, SAM, 'Could we sort by value?', ago(0.05), dealsVersions[2]?.id ?? ''),
        response(2, ME, 'Globex closes next week', ago(0.5), dealsVersions[2]?.id ?? ''),
        response(1, SAM, 'Love this, thanks', ago(2), dealsVersions[1]?.id ?? ''),
      ],
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
      data: {},
      submissions: [],
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

  /** The newest version of each reviewed binding that was not let through. */
  const waiting = (entry: MockApp): AppDataUpdate[] =>
    Object.entries(entry.data).flatMap(([name, binding]) => {
      const newest = binding.versions.at(-1);
      if (!newest || newest.artifact_id === binding.released) return [];
      const before = binding.versions.find((v) => v.artifact_id === binding.released) ?? null;
      const from = Array.isArray(before?.value) ? before.value.length : 0;
      const to = Array.isArray(newest.value) ? newest.value.length : 0;
      return [
        {
          binding: name,
          path: 'data/deals.json',
          artifact_id: newest.artifact_id,
          written_at: newest.written_at,
          size: newest.size,
          size_before: before?.size ?? null,
          changes: null,
          summary: before
            ? `${from} → ${to} items, ${before.size} → ${newest.size} bytes`
            : `First version, ${newest.size} bytes`,
        },
      ];
    });

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
        review: binding.review === true,
      })),
      data_waiting: manager ? waiting(entry).length : null,
      collections: Object.entries(current?.manifest.collections ?? {}).map(([name, value]) => ({
        name,
        max_bytes: value.max_bytes,
      })),
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

  // The data a binding reads. Deals has one, `deals`, which its publisher reviews.
  app.get('/apps/:id/data/:name', (c) => {
    const entry = apps.get(c.req.param('id'));
    const name = c.req.param('name');
    const current = entry?.versions.find((v) => v.id === entry.current);
    const binding = current?.manifest.data[name];
    if (!entry || !binding) return missing();
    const versions = entry.data[name]?.versions ?? [];
    const shown = binding.review
      ? versions.find((v) => v.artifact_id === entry.data[name]?.released)
      : versions.at(-1);
    return Response.json(
      appDataValue.parse({
        name,
        state: shown ? 'ready' : 'none',
        format: shown ? 'json' : null,
        value: shown?.value ?? null,
        updated_at: shown?.written_at ?? null,
      }),
    );
  });

  app.get('/apps/:id/data-updates', (c) => {
    const entry = apps.get(c.req.param('id'));
    if (!entry) return missing();
    return Response.json(appDataUpdates.parse({ updates: waiting(entry) }));
  });

  app.post('/apps/:id/data-updates', async (c) => {
    const entry = apps.get(c.req.param('id'));
    const input = appDataReleaseRequest.safeParse(await c.req.json().catch(() => null));
    const binding = input.success ? entry?.data[input.data.binding] : undefined;
    if (!entry || !input.success || !binding) return missing();
    if (binding.versions.at(-1)?.artifact_id !== input.data.artifact_id)
      return Response.json(
        { error: { code: 'conflict', message: 'A newer version was written since.' } },
        { status: 409 },
      );
    binding.released = input.data.artifact_id;
    return Response.json(appDataUpdates.parse({ updates: waiting(entry) }));
  });

  app.post('/apps/:id/submissions', async (c) => {
    const entry = apps.get(c.req.param('id'));
    const current = entry?.versions.find((v) => v.id === entry.current);
    if (!entry || !current) return missing();
    const input = appSubmissionRequest.safeParse(await c.req.json().catch(() => null));
    if (!input.success || !current.manifest.collections[input.data.collection])
      return Response.json(
        { error: { code: 'invalid_request', message: 'This app does not collect that.' } },
        { status: 400 },
      );
    const created = now().toISOString();
    const id = `asub_${sha(`${created}${entry.submissions.length}`)
      .slice(0, 26)
      .toUpperCase()
      .replace(/[ILOU]/g, '0')}`;
    entry.submissions.unshift({
      id,
      collection: input.data.collection,
      version_id: current.id,
      by: ME,
      data: input.data.record,
      created_at: created,
    });
    return Response.json(appSubmissionAccepted.parse({ id, created_at: created }));
  });

  app.get('/apps/:id/submissions', (c) => {
    const entry = apps.get(c.req.param('id'));
    if (!entry) return missing();
    const collection = c.req.query('collection');
    return Response.json(
      appSubmissionList.parse({
        submissions: entry.submissions.filter(
          (submission) => !collection || submission.collection === collection,
        ),
        next_before: null,
      }),
    );
  });

  app.delete('/apps/:id/submissions', (c) => {
    const entry = apps.get(c.req.param('id'));
    const from = c.req.query('from');
    if (!entry || !from) return missing();
    const before = entry.submissions.length;
    entry.submissions = entry.submissions.filter((submission) => submission.by?.id !== from);
    return Response.json(
      appSubmissionsDeleted.parse({ from, deleted: before - entry.submissions.length }),
    );
  });

  app.delete('/apps/:id/submissions/:submission_id', (c) => {
    const entry = apps.get(c.req.param('id'));
    const id = c.req.param('submission_id');
    if (!entry) return missing();
    if (!entry.submissions.some((submission) => submission.id === id)) return missing();
    entry.submissions = entry.submissions.filter((submission) => submission.id !== id);
    return Response.json(appSubmissionDeleted.parse({ id, deleted: true }));
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
