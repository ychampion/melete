/**
 * A person's preview of a server running in an agent's computer, and the
 * other things they may do with that computer's background processes: read
 * the end of what one printed, and stop it.
 *
 * Opening a preview (`POST /sandbox/processes/:id/previews`) is the person's
 * own request in their own browser session. It is allowed only to the person
 * whose job started the process, in a space they may still use, while the
 * process runs, declared a port, and listens on it, in a computer the service
 * shares a network with. It answers with a path carrying a token: an app view
 * token (viewer/tokens.ts), signed with a key of its own, whose "app" is the
 * process and whose "version" is a digest of the process, its port and the
 * computer it runs in. Like an app view, it is tied to the browser session
 * that opened it.
 *
 * `GET /previews/:token/*` reads no session: Melete frames the page in a
 * sandboxed iframe, it has an opaque origin and holds none. On every request
 * it checks the token, the browser session, that the person may still watch
 * the computer, that the process record still says it runs with that port in
 * that computer (whether it listens is asked only when the preview is opened),
 * and then forwards the request to that one port at the computer's own
 * address on its private network, and nowhere else:
 *
 * - only GET and HEAD, with a short allow-list of request headers. The
 *   Melete cookie, any credentials and every other header stay here, and no
 *   connection upgrade (a live-reload socket) is passed on;
 * - the answer leaves with the app viewer's isolation headers
 *   (viewer/headers.ts) and a short allow-list of the server's own, never its
 *   cookies; a redirect is kept inside the preview or refused;
 * - a page, script or style that links to its own site from the root (`/src/
 *   main.js`) has those links made relative, so they load through the preview
 *   rather than from Melete.
 */
import { createHash, createHmac } from 'node:crypto';
import {
  PREVIEW_LIMITS,
  PROCESS_LIMITS,
  type ProcessOutput,
  type ProcessPreview,
  type ProcessStopped,
  processOutput,
  processPreview,
  processStopped,
} from '@melete/contracts';
import type { Context, Hono } from 'hono';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import { sessionLive } from '../apps/serve.ts';
import { terminalText } from '../experience/computer.ts';
import { framedRequest, viewHeaders } from '../viewer/headers.ts';
import { sessionTag, VIEW_TTL_SECONDS, ViewTokens } from '../viewer/tokens.ts';
import { PREVIEW_PREFIX } from './preview-path.ts';
import { helperComputer, type ProcessComputer } from './process-helper.ts';
import {
  type ProcessProviders,
  type ProcessRow,
  rowOf,
  type SandboxProcesses,
} from './processes.ts';
import type { PreviewAddress, SandboxHandle, SandboxProvider } from './types.ts';

/** One process a person may watch, and the computer it runs in, if that is running. */
export type WatchedProcess = {
  row: ProcessRow;
  computer: { provider: SandboxProvider; handle: SandboxHandle } | null;
};

/** What the preview needs to know about people, processes and computers. */
export interface PreviewAccess {
  /** The process, when this person may watch the computer it runs in; otherwise null. */
  watched(processId: string, principalId: string): Promise<WatchedProcess | null>;
  /** Whether the browser session a preview was opened from is still signed in. */
  sessionLive(principalId: string, tag: string): Promise<boolean>;
}

/**
 * The person whose job started the process, in a space they may still use,
 * with the computer's connection still active. Rooms are not on this side
 * yet, so a shared computer's other members see nothing here.
 */
export function sqlPreviewAccess(sql: Sql, providers: ProcessProviders): PreviewAccess {
  return {
    async watched(processId, principalId) {
      const [row] = await sql`select p.*, w.provider_sandbox_id, w.image_digest, w.region
        from sandbox_process p
        join job j on j.id = p.job_id and j.space_id = p.space_id
        join space s on s.id = p.space_id
        join connection n on n.id = p.connection_id
        left join lateral (select provider_sandbox_id, image_digest, region from sandbox_session
            where space_id = p.space_id and agent_id = p.agent_id
              and connection_id = p.connection_id and status = 'ready'
            order by opened_at desc limit 1) w on true
        where p.id = ${processId} and s.removed_at is null and n.status = 'active'
          -- A job with no recorded person is the space owner's, as everywhere else; only a
          -- personal space with no recorded owner falls back to the installation's.
          and coalesce(j.principal_id, s.owner_principal_id,
            case when s.kind = 'personal' then (select id from owner limit 1) end) = ${principalId}
          and ((s.kind = 'personal'
              and coalesce(s.owner_principal_id, (select id from owner limit 1)) = ${principalId})
            or (s.kind = 'shared' and exists (select 1 from space_membership m
              where m.space_id = s.id and m.principal_id = ${principalId}
                and m.revoked_at is null)))`;
      if (!row) return null;
      const held = providers().get(String(row.connection_id));
      return {
        row: rowOf(row),
        computer:
          held && row.provider_sandbox_id
            ? {
                provider: held.provider,
                handle: {
                  providerSandboxId: String(row.provider_sandbox_id),
                  imageDigest: (row.image_digest as string | null) ?? null,
                  region: (row.region as string | null) ?? null,
                },
              }
            : null,
      };
    },
    sessionLive: (principalId, tag) => sessionLive(sql, principalId, tag),
  };
}

/** A refusal the person is told about in words. */
const refused = (message: string, status: 404 | 409 = 409) =>
  new ServiceError(status === 404 ? 'not_found' : 'conflict', message, status);

const NO_PROCESS = 'No such process on a computer you can watch.';

const ended = (why: string) =>
  new ServiceError(
    'not_found',
    `This preview has ended. ${why} Open it again from the computer view.`,
    404,
  );

/** What the token's "version" names: this process, on this port, in this computer. */
export function previewBinding(row: ProcessRow, computer: WatchedProcess['computer']): string {
  return createHash('sha256')
    .update(
      [
        'melete preview',
        row.id,
        String(row.port),
        row.connectionId,
        computer?.handle.providerSandboxId ?? '',
      ].join('\n'),
    )
    .digest('hex');
}

/**
 * When a preview ends: half an hour after it was opened. A view token is
 * signed to last the app viewer's longer time, so the preview's own end is
 * counted from when it was issued; the computer view opens a new one before
 * then while the preview is on screen.
 */
export const previewEnds = (tokenExpiresAt: number): number =>
  tokenExpiresAt - VIEW_TTL_SECONDS + PREVIEW_LIMITS.ttl_seconds;

/** The view token key, kept apart from the app viewer's: an app's token never opens a preview. */
const previewKey = (masterKey: string | undefined) =>
  masterKey
    ? createHmac('sha256', masterKey).update('melete preview token v1').digest('hex')
    : undefined;

/** Request headers a previewed server is given; everything else stays here. */
const FORWARDED = [
  'accept',
  'accept-language',
  'cache-control',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'if-unmodified-since',
  'range',
  'user-agent',
] as const;

/** The server's own response headers that are passed on, besides its content type. */
const RETURNED = [
  'accept-ranges',
  'content-language',
  'content-range',
  'etag',
  'last-modified',
  'vary',
] as const;

/** Types whose root-relative links to the server's own site are kept inside the preview. */
const REWRITTEN = new Set([
  'text/html',
  'text/css',
  'text/javascript',
  'application/javascript',
  'application/xhtml+xml',
]);

const essence = (contentType: string) => contentType.split(';')[0]?.trim().toLowerCase() ?? '';

/**
 * How a page at `rest` (the path below the token) names the preview's own
 * root, relatively: `./` from the top, one `../` for each directory below it.
 * Relative links resolve against the address the browser used, so they reach
 * the preview without this service knowing where it is mounted.
 */
export function rootFrom(rest: string): string {
  const depth = rest.split('/').length - 2;
  return depth > 0 ? '../'.repeat(depth) : './';
}

/**
 * Links to the server's own root (`"/src/main.js"`, never `"//elsewhere"`),
 * made relative to the preview's root: in attributes, module imports, and
 * style sheets.
 */
export function keepInside(text: string, root: string): string {
  return text
    .replace(
      /(\s(?:src|href|action|formaction|poster|data)\s*=\s*)(["']?)\/(?![/\\])/gi,
      `$1$2${root}`,
    )
    .replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'`])\/(?![/\\])/g, `$1$2${root}`)
    .replace(/(\burl\(\s*)(["']?)\/(?![/\\])/gi, `$1$2${root}`)
    .replace(/(@import\s+)(["'])\/(?![/\\])/gi, `$1$2${root}`);
}

const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

/**
 * Where a redirect from the server goes, as a path inside the preview, or
 * null when it points anywhere other than this server.
 */
export function relocate(location: string, address: PreviewAddress, rest: string): string | null {
  let url: URL;
  try {
    url = new URL(location, `http://localhost:${address.port}${rest}`);
  } catch {
    return null;
  }
  const host = url.hostname;
  const ours = LOCAL_NAMES.has(host) || host === address.host || host === `[${address.host}]`;
  if (url.protocol !== 'http:' || !ours || Number(url.port || 80) !== address.port) return null;
  return `${rootFrom(rest)}${url.pathname.slice(1)}${url.search}${url.hash}`;
}

/** A body passed on as it arrives, cut off with an error past the limit. */
function capped(body: ReadableStream<Uint8Array>, limit: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > limit) controller.error(new Error('the previewed answer is too large'));
        else controller.enqueue(chunk);
      },
    }),
  );
}

/**
 * The whole body when it fits under `limit`, or null. On null the body is not
 * lost: `rest` replays what was read, then the remainder as it arrives.
 */
async function readUpTo(
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<{ bytes: Uint8Array } | { bytes: null; rest: ReadableStream<Uint8Array> }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > limit) {
      const rest = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
        },
        async pull(controller) {
          const next = await reader.read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        cancel: (reason) => reader.cancel(reason),
      });
      return { bytes: null, rest };
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { bytes };
}

/** A plain refusal from the preview itself, with the isolation headers. */
const plain = (status: number, text: string) =>
  new Response(`${text}\n`, { status, headers: viewHeaders('text/plain; charset=utf-8') });

/**
 * Forward one request to the one port at the computer's address, and shape
 * the answer. `rest` is the path below the token, starting with `/`.
 */
export async function forwardPreview(input: {
  address: PreviewAddress;
  method: 'GET' | 'HEAD';
  rest: string;
  search: string;
  headers: Headers;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<Response> {
  const { address, rest } = input;
  const host = address.host.includes(':') ? `[${address.host}]` : address.host;
  const origin = `http://${host}:${address.port}`;
  // Only the path and query are set, on a fixed origin: nothing in the
  // request can choose another host or port.
  const target = new URL(origin);
  target.pathname = rest;
  target.search = input.search;
  if (target.origin !== new URL(origin).origin)
    return plain(400, 'This address cannot be previewed.');
  const headers = new Headers();
  for (const name of FORWARDED) {
    const value = input.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // Development servers answer only to the names they expect.
  headers.set('host', `localhost:${address.port}`);
  headers.set('accept-encoding', 'identity');
  let upstream: Response;
  try {
    upstream = await (input.fetch ?? fetch)(target, {
      method: input.method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.any([
        ...(input.signal ? [input.signal] : []),
        AbortSignal.timeout(PREVIEW_LIMITS.upstream_timeout_ms),
      ]),
    });
  } catch {
    return plain(
      502,
      `Nothing answered on port ${address.port} at the computer's network address. A server started to listen only on localhost cannot be previewed: start it listening on all addresses (0.0.0.0).`,
    );
  }
  const type = upstream.headers.get('content-type') ?? 'application/octet-stream';
  const answered = viewHeaders(type);
  for (const name of RETURNED) {
    const value = upstream.headers.get(name);
    if (value !== null) answered.set(name, value);
  }
  const status = upstream.status;
  if (status >= 300 && status < 400 && upstream.headers.has('location')) {
    const location = relocate(upstream.headers.get('location') ?? '', address, rest);
    if (location === null) {
      await upstream.body?.cancel();
      return plain(502, 'The previewed page tried to send you to another site.');
    }
    answered.set('location', location);
  }
  const length = Number(upstream.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(length) && length > PREVIEW_LIMITS.response_max_bytes) {
    await upstream.body?.cancel();
    return plain(502, 'That answer is too large to preview.');
  }
  if (input.method === 'HEAD' || !upstream.body || status === 204 || status === 304) {
    await upstream.body?.cancel();
    return new Response(null, { status, headers: answered });
  }
  // A page, script or style small enough is read whole to keep its links
  // inside the preview. A larger one is passed on as it arrives, unchanged,
  // so no answer is ever held whole in memory past that size.
  if (
    REWRITTEN.has(essence(type)) &&
    !(Number.isFinite(length) && length > PREVIEW_LIMITS.rewrite_max_bytes)
  ) {
    const read = await readUpTo(upstream.body, PREVIEW_LIMITS.rewrite_max_bytes);
    if (read.bytes) {
      const text = keepInside(new TextDecoder().decode(read.bytes), rootFrom(rest));
      return new Response(text, { status, headers: answered });
    }
    return new Response(capped(read.rest, PREVIEW_LIMITS.response_max_bytes), {
      status,
      headers: answered,
    });
  }
  return new Response(capped(upstream.body, PREVIEW_LIMITS.response_max_bytes), {
    status,
    headers: answered,
  });
}

export type SandboxPreviewsOptions = {
  masterKey?: string;
  now?: () => number;
  /** How the service reaches a computer's processes; the helper unless a test says otherwise. */
  computerFor?: (provider: SandboxProvider, handle: SandboxHandle) => ProcessComputer;
  /** Stops processes and closes their records. Without it, stopping is refused. */
  processes?: SandboxProcesses;
  fetch?: typeof fetch;
};

const COMPUTER_MS = 15_000;

export class SandboxPreviews {
  readonly tokens: ViewTokens;
  private readonly computerFor: NonNullable<SandboxPreviewsOptions['computerFor']>;
  private readonly now: () => number;

  constructor(
    private readonly access: PreviewAccess,
    private readonly options: SandboxPreviewsOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.tokens = new ViewTokens(previewKey(options.masterKey), this.now);
    this.computerFor =
      options.computerFor ??
      ((provider, handle) =>
        options.processes?.computer(provider, handle) ?? helperComputer(provider, handle));
  }

  /** The process, running with a port, in a computer the service can reach now. */
  private async live(
    processId: string,
    principalId: string,
  ): Promise<{
    watched: WatchedProcess;
    port: number;
    computer: NonNullable<WatchedProcess['computer']>;
    address: PreviewAddress;
  }> {
    const watched = await this.access.watched(processId, principalId);
    if (!watched) throw refused(NO_PROCESS, 404);
    const { row, computer } = watched;
    if (row.state !== 'running') throw refused('That process is not running.');
    if (row.port === null)
      throw refused('That process serves no port, so there is no page to preview.');
    if (!computer) throw refused("That process's computer is not running right now.");
    const lookup = computer.provider.previewAddress?.bind(computer.provider);
    if (!lookup || computer.provider.capabilities.ports === 'none')
      throw refused('Pages in this computer cannot be previewed: its provider offers no way in.');
    const address = await lookup(computer.handle, row.port, AbortSignal.timeout(COMPUTER_MS));
    if (!address)
      throw refused(
        'This computer has no network its pages can be previewed over: its sandbox connection allows no network access, or it is stopped.',
      );
    return { watched, port: row.port, computer, address };
  }

  async open(
    processId: string,
    principalId: string,
    sessionDigest: string | undefined,
  ): Promise<ProcessPreview> {
    // A preview lives as long as the browser session that opened it.
    if (!sessionDigest)
      throw new ServiceError('forbidden', 'Previews open in Melete, signed in in a browser.', 403);
    const { watched, port, computer } = await this.live(processId, principalId);
    let ports: number[] = [];
    try {
      const status = await this.computerFor(computer.provider, computer.handle).status(
        [processId],
        AbortSignal.timeout(COMPUTER_MS),
      );
      ports = status.processes.find((facts) => facts.id === processId)?.ports ?? [];
    } catch {
      throw refused('The computer did not answer, so the preview was not opened. Try again.');
    }
    if (!ports.includes(port))
      throw refused(`Nothing in that process is listening on port ${port} yet. Try again shortly.`);
    const { token, expiresAt: outer } = this.tokens.issue({
      principalId,
      appId: processId,
      versionId: previewBinding(watched.row, computer),
      grantGeneration: 0,
      sessionTag: sessionTag(sessionDigest),
    });
    return processPreview.parse({
      process_id: processId,
      path: `${PREVIEW_PREFIX}${token}/`,
      port,
      expires_at: new Date(previewEnds(outer) * 1000).toISOString(),
    });
  }

  /** One request from a framed preview. Every check runs again. */
  async serve(c: Context): Promise<Response> {
    if (!framedRequest(c.req.header('sec-fetch-dest')))
      throw new ServiceError('forbidden', 'Open this preview from Melete.', 403);
    if (c.req.header('upgrade') !== undefined)
      throw new ServiceError(
        'invalid_request',
        'Live connections, such as automatic reload, are not passed to previews.',
        400,
      );
    const url = new URL(c.req.url);
    const below = url.pathname.slice(PREVIEW_PREFIX.length);
    const slash = below.indexOf('/');
    if (slash < 1) throw ended('Its address is incomplete.');
    const claims = this.tokens.verify(below.slice(0, slash));
    if (!claims || previewEnds(claims.expiresAt) * 1000 <= this.now()) throw ended('It expired.');
    if (!(await this.access.sessionLive(claims.principalId, claims.sessionTag)))
      throw ended('The session that opened it signed out.');
    let live: Awaited<ReturnType<SandboxPreviews['live']>>;
    try {
      live = await this.live(claims.appId, claims.principalId);
    } catch (error) {
      if (error instanceof ServiceError) throw ended(error.message);
      throw error;
    }
    if (previewBinding(live.watched.row, live.computer) !== claims.versionId)
      throw ended('The process or its computer changed.');
    return forwardPreview({
      address: live.address,
      method: c.req.method === 'HEAD' ? 'HEAD' : 'GET',
      rest: below.slice(slash),
      search: url.search,
      headers: c.req.raw.headers,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      signal: c.req.raw.signal,
    });
  }

  /** The end of what the process printed, or its last recorded line when its computer is out of reach. */
  async output(processId: string, principalId: string): Promise<ProcessOutput> {
    const watched = await this.access.watched(processId, principalId);
    if (!watched) throw refused(NO_PROCESS, 404);
    const { row, computer } = watched;
    let text: string | null = null;
    if (computer)
      try {
        const answer = await this.computerFor(computer.provider, computer.handle).read(
          processId,
          -1,
          PREVIEW_LIMITS.output_bytes,
          0,
          AbortSignal.timeout(COMPUTER_MS),
        );
        text = new TextDecoder().decode(answer.data);
      } catch {
        text = null;
      }
    return processOutput.parse({
      process_id: processId,
      state: row.state,
      text: terminalText(text ?? row.lastLine ?? '', PREVIEW_LIMITS.output_bytes, 'last'),
    });
  }

  /** Stop the process, as `process.stop` would: TERM, then KILL after the grace period. */
  async stop(processId: string, principalId: string): Promise<ProcessStopped> {
    const watched = await this.access.watched(processId, principalId);
    const processes = this.options.processes;
    if (!watched || !processes) throw refused(NO_PROCESS, 404);
    const { row, computer } = watched;
    if (row.state !== 'running' && row.state !== 'starting')
      return processStopped.parse({ process_id: processId, state: row.state });
    const after = await processes.end(
      row,
      computer ? this.computerFor(computer.provider, computer.handle) : null,
      'stopped',
      'the person stopped it from the computer view',
      AbortSignal.timeout(PROCESS_LIMITS.stop_grace_ms + COMPUTER_MS),
      PROCESS_LIMITS.stop_grace_ms,
    );
    return processStopped.parse({ process_id: processId, state: after.state });
  }
}

/**
 * Previews for an installation that owns sandboxes, or nothing when it owns
 * none. The providers are the connector factory's, as the process sweep's are.
 */
export function previewsFor(
  sql: Sql,
  factory: {
    options: { sandbox?: { processes?: SandboxProcesses } };
    sandboxProviders: ReadonlyMap<string, { adapter: string; provider: SandboxProvider }>;
  },
  masterKey: string | undefined,
): SandboxPreviews | undefined {
  const processes = factory.options.sandbox?.processes;
  if (!processes) return undefined;
  return new SandboxPreviews(
    sqlPreviewAccess(sql, () => factory.sandboxProviders),
    masterKey ? { processes, masterKey } : { processes },
  );
}

/**
 * The person's routes, behind the session and same-origin middleware, and
 * the preview path itself, which reads no session (see api/auth.ts) and
 * leaves through the isolation middleware (index.ts).
 */
export function mountSandboxPreviews(app: Hono, previews: SandboxPreviews): void {
  const owner = (c: Context) => {
    const id = c.get('owner')?.id as string | undefined;
    if (!id) throw refused(NO_PROCESS, 404);
    return id;
  };
  app.post('/sandbox/processes/:id/previews', async (c) =>
    c.json(
      await previews.open(
        c.req.param('id'),
        owner(c),
        c.get('sessionDigest') as string | undefined,
      ),
    ),
  );
  app.get('/sandbox/processes/:id/output', async (c) =>
    c.json(await previews.output(c.req.param('id'), owner(c))),
  );
  app.post('/sandbox/processes/:id/stop', async (c) =>
    c.json(await previews.stop(c.req.param('id'), owner(c))),
  );
  // Reads only; a GET route answers HEAD too.
  app.get(`${PREVIEW_PREFIX}:token/`, (c) => previews.serve(c));
  app.get(`${PREVIEW_PREFIX}:token/:path{.+}`, (c) => previews.serve(c));
}
