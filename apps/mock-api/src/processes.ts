/**
 * Background processes in the agent's computer, for looking at the Processes
 * strip: with MELETE_MOCK_PROCESSES=1 every conversation's computer has a dev
 * server that can be previewed, a watcher started by someone else, and a test
 * run that finished. The preview serves a small page of its own with the
 * service's isolation headers.
 */
import { randomBytes } from 'node:crypto';
import * as C from '@melete/contracts';
import type { Hono } from 'hono';
import { PREVIEW_PREFIX } from '../../melete/src/sandbox/preview-path.ts';
import { VIEW_POLICY, viewHeaders } from '../../melete/src/viewer/headers.ts';

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Deals board</title>
<link rel="stylesheet" href="/style.css"></head><body><main>
<h1>Deals board</h1><p>Served by the dev server in the agent's computer, on port 5173.</p>
<ul><li>Acme renewal: $12,000</li><li>Globex pilot: $4,500</li></ul>
<p id="origin"></p></main><script type="module" src="/src/main.js"></script></body></html>`;
const STYLE = `body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:24px;color:#17191d;background:#fff}
h1{font-size:22px;margin:0 0 8px}ul{padding-left:20px}#origin{color:#676c7c;font-size:13px}`;
const SCRIPT = `document.getElementById('origin').textContent =
  'This page runs with origin ' + self.origin + ', apart from Melete.';`;
const FILES: Record<string, { body: string; type: string }> = {
  '/': { body: PAGE, type: 'text/html; charset=utf-8' },
  '/style.css': { body: STYLE, type: 'text/css; charset=utf-8' },
  '/src/main.js': { body: SCRIPT, type: 'text/javascript; charset=utf-8' },
};

export class ProcessesMock {
  private readonly stopped = new Set<string>();
  private readonly previews = new Map<string, string>();

  constructor(readonly enabled = process.env.MELETE_MOCK_PROCESSES === '1') {}

  /** The processes on a conversation's computer. */
  list(): C.ComputerProcess[] {
    if (!this.enabled) return [];
    const state = (id: string) => (this.stopped.has(id) ? 'stopped' : 'running');
    return [
      {
        id: 'prc_01JDEVSERVER00000000000000',
        name: 'npm run dev',
        state: state('prc_01JDEVSERVER00000000000000'),
        started_at: minutesAgo(14),
        port: 5173,
        last_line: '  ➜  Local:   http://0.0.0.0:5173/',
        can_preview: !this.stopped.has('prc_01JDEVSERVER00000000000000'),
      },
      {
        id: 'prc_01JWATCHER0000000000000000',
        name: 'Process',
        state: state('prc_01JWATCHER0000000000000000'),
        started_at: minutesAgo(95),
        port: 8080,
        last_line: null,
        can_preview: false,
      },
      {
        id: 'prc_01JTESTRUN0000000000000000',
        name: 'bun test',
        state: 'exited',
        started_at: minutesAgo(40),
        port: null,
        last_line: ' 412 pass, 0 fail',
        can_preview: false,
      },
    ];
  }

  mount(app: Hono): void {
    const found = (id: string) => this.list().find((each) => each.id === id);
    const missing = () =>
      Response.json(
        { error: { code: 'not_found', message: 'No such process on a computer you can watch.' } },
        { status: 404 },
      );
    app.post('/sandbox/processes/:id/previews', (c) => {
      const process = found(c.req.param('id'));
      if (!process?.can_preview || process.port === null) return missing();
      const token = randomBytes(18).toString('base64url');
      this.previews.set(token, process.id);
      return c.json(
        C.processPreview.parse({
          process_id: process.id,
          path: `${PREVIEW_PREFIX}${token}/`,
          port: process.port,
          expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        }),
      );
    });
    app.get('/sandbox/processes/:id/output', (c) => {
      const process = found(c.req.param('id'));
      if (!process) return missing();
      return c.json(
        C.processOutput.parse({
          process_id: process.id,
          state: process.state,
          text: process.last_line
            ? `> vite\n\n  VITE v6.0.0  ready in 312 ms\n\n${process.last_line}\n`
            : '',
        }),
      );
    });
    app.post('/sandbox/processes/:id/stop', (c) => {
      const process = found(c.req.param('id'));
      if (!process) return missing();
      if (process.state === 'running') this.stopped.add(process.id);
      return c.json(C.processStopped.parse({ process_id: process.id, state: 'stopped' }));
    });
    app.get(`${PREVIEW_PREFIX}:token/*`, (c) => {
      const url = new URL(c.req.url);
      const token = c.req.param('token');
      const rest = url.pathname.slice(`${PREVIEW_PREFIX}${token}`.length) || '/';
      const processId = this.previews.get(token);
      const file = FILES[rest];
      if (!processId || this.stopped.has(processId) || !file)
        return new Response('{"error":{"code":"not_found","message":"This preview has ended."}}', {
          status: 404,
          headers: viewHeaders('application/json'),
        });
      // Root links made relative, as the service's proxy does.
      const depth = rest.split('/').length - 2;
      const root = depth > 0 ? '../'.repeat(depth) : './';
      const headers = viewHeaders(file.type);
      // As for apps: any page may frame it in development, unless asked for the exact policy.
      if (process.env.MELETE_MOCK_APP_FRAMES !== 'self')
        headers.set(
          'content-security-policy',
          VIEW_POLICY.replace("frame-ancestors 'self'", 'frame-ancestors *'),
        );
      return new Response(file.body.replaceAll('="/', `="${root}`), { headers });
    });
  }
}
