/**
 * A stand-in for Maritime's computers API, used only to author fixtures and to
 * test the adapter without an account.
 *
 * It answers the requests the Maritime adapter makes in the shapes Maritime
 * publishes (maritime.sh/docs/computers and the API's OpenAPI document) and,
 * where they are silent, behaves as described here; every such choice is an
 * open question for the live test to settle:
 *
 * - `POST /api/v1/computers` is get-or-create by `externalUserId`: 201 with a
 *   new computer, 200 with the one that exists. A new computer is awake.
 * - `exec` runs its command through `sh -c` as the desktop user `desk` in
 *   `/home/desk`, with no stdin, and answers `{exitCode, stdout, stderr}`. At
 *   `timeoutS` the command is killed and `exitCode` is null. A process the
 *   command started in the background keeps running after `exec` answers.
 * - The files API reaches `/data` and `/home/desk` only (400 `bad_path`
 *   elsewhere or with `..`), 8 MiB at most per read or write (413), answers
 *   404 `not_found` for a missing file and 400 for a directory, and makes a
 *   written file's missing parents.
 * - Sleeping keeps the computer's memory, so what runs keeps running; any
 *   action, `exec` or file call wakes it. `GET` does not.
 * - A deleted computer is 404 `not_found` afterwards.
 * - The desktop user is not root and has no `sudo`: nothing can be made at the
 *   top of the filesystem, so `/work` cannot be made, as on a real computer.
 * - The computer's egress is open.
 * - A link to drive the desktop holds it for a person from the moment it is made,
 *   opened or not, until they press Done in the viewer or a minute or so after it
 *   runs out (`RELEASE_GRACE_MS`), as the live test found; a new one ends the one
 *   before and holds it from then on. Closing the session ends no hold. A link to
 *   watch holds nothing.
 *
 * Fixtures written through it are marked `authored-from-documented-api`. They
 * prove the adapter speaks the published protocol; they are not evidence of
 * how Maritime behaves. The live test is.
 */
import { type FakeSandbox, FakeSandboxEngine, FsError } from '../fake.ts';
import { MARITIME_API_URL } from './maritime.ts';

export const AUTHORING_KEY = 'mk_authoring_only_not_a_credential_0000';

const CREATED_AT = '2026-10-18T00:00:00.000Z';
const FILE_LIMIT = 8 * 1024 * 1024;
const PREFIX = '/api/v1/computers';
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });

/** Maritime's error body: a slug, a message and, when it helps, when to retry. */
const failure = (status: number, error: string, message: string, retryAfterS?: number) =>
  json(status, { error, message, ...(retryAfterS === undefined ? {} : { retryAfterS }) });

function bodyBytes(body: RequestInit['body']): Uint8Array {
  if (body === undefined || body === null) return new Uint8Array(0);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  throw new Error('the stand-in reads only string and byte bodies');
}

type Held = {
  sandbox: FakeSandbox;
  externalUserId: string | null;
  name: string | null;
  os: string;
  arch: string;
  status: 'awake' | 'asleep';
  lastActionAt: string | null;
};

/** A one-pixel PNG: what a screenshot of a blank screen is, as far as a test cares. */
const PIXEL = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ),
);

/** A PNG header of the given size: enough for anything that reads a screenshot's size. */
function pngOfSize(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/**
 * How long after a link to drive the desktop runs out Maritime gives the desktop
 * back by itself: live, a thirty-second link left unopened was still held 45 s
 * after it was made and back with the agent 100 s after.
 */
export const RELEASE_GRACE_MS = 60_000;

export function createMaritimeStandin(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const engine = new FakeSandboxEngine();
  const records = new Map<string, Held>();
  let refuseSleep = false;
  let viewers = 0;
  /**
   * Computers a person holds through a control link, until when (never, for one
   * held by `hold`): every action is refused meanwhile.
   */
  const held = new Map<string, number>();
  const holding = (id: string) => {
    const until = held.get(id);
    if (until === undefined) return false;
    if (now() < until) return true;
    held.delete(id);
    return false;
  };
  /** Every viewer link asked for, in order, with how long it was asked to last. */
  const minted: { id: string; mode: string; ttlS: number | null }[] = [];
  /** Each action asked for, by computer, in order. */
  const acted: { id: string; actions: Record<string, unknown>[] }[] = [];
  /** Computers whose session was closed, in order. */
  const closed: string[] = [];
  /** The size screenshots come back at; the one-pixel PNG when unset. */
  let frame: { width: number; height: number } | null = null;

  const out = (record: Held) => ({
    id: record.sandbox.id,
    os: record.os,
    arch: record.arch,
    externalUserId: record.externalUserId,
    name: record.name,
    status: record.status,
    screen: { width: 1280, height: 800, modelWidth: 1200 },
    mode: holding(record.sandbox.id) ? 'human' : 'agent',
    modeReason: null,
    lastActionAt: record.lastActionAt,
    lastWakeMs: null,
    lastWakeMethod: null,
    errorMessage: null,
    session: null,
    createdAt: CREATED_AT,
  });

  const wake = (record: Held) => {
    record.status = 'awake';
    record.sandbox.state = 'running';
    record.lastActionAt = CREATED_AT;
  };

  const allowed = (path: string) =>
    (path.startsWith('/data/') || path.startsWith('/home/desk/')) &&
    !path.split('/').includes('..');

  function create(init: RequestInit): Response {
    const body = JSON.parse(new TextDecoder().decode(bodyBytes(init.body)) || '{}') as {
      externalUserId?: unknown;
      name?: unknown;
      os?: unknown;
      arch?: unknown;
    };
    const os = body.os ?? 'linux';
    const arch = body.arch ?? 'x86_64';
    if (os !== 'linux' || (arch !== 'x86_64' && arch !== 'arm64'))
      return failure(400, 'validation', 'the stand-in makes linux computers only');
    if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 256))
      return failure(422, 'validation', 'name is at most 256 characters');
    const externalUserId = typeof body.externalUserId === 'string' ? body.externalUserId : null;
    if (externalUserId) {
      const existing = [...records.values()].find(
        (record) => record.externalUserId === externalUserId,
      );
      if (existing) return json(200, out(existing));
    }
    const sandbox = engine.create({
      image: `${os}-${arch}`,
      egress: { kind: 'open' },
      labels: {},
      env: { HOME: '/home/desk', USER: 'desk', LOGNAME: 'desk', DISPLAY: ':0' },
      lifetimeSeconds: 24 * 3600,
    });
    sandbox.fs.mkdir('/data', true);
    sandbox.fs.mkdir('/home/desk', true);
    // Root's, as on Maritime: the desktop user cannot make /work there.
    sandbox.fs.seal('/');
    const record: Held = {
      sandbox,
      externalUserId,
      name: typeof body.name === 'string' ? body.name : null,
      os,
      arch,
      status: 'awake',
      lastActionAt: null,
    };
    records.set(sandbox.id, record);
    return json(201, out(record));
  }

  async function exec(record: Held, init: RequestInit): Promise<Response> {
    const body = JSON.parse(new TextDecoder().decode(bodyBytes(init.body)) || '{}') as {
      command?: unknown;
      timeoutS?: unknown;
    };
    if (typeof body.command !== 'string' || !body.command || body.command.length > 8192)
      return failure(422, 'validation', 'command is 1 to 8192 characters');
    const timeoutS = body.timeoutS ?? 30;
    if (typeof timeoutS !== 'number' || timeoutS < 1 || timeoutS > 30)
      return failure(422, 'validation', 'timeoutS is 1 to 30');
    wake(record);
    // The fake has one output stream; it all comes back as `stdout`.
    const stdout: Uint8Array[] = [];
    const child = engine.spawn(record.sandbox, ['sh', '-c', body.command], {
      cwd: '/home/desk',
      onOutput: (bytes) => stdout.push(bytes),
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutS * 1000);
    const result = await child.done;
    clearTimeout(timer);
    return json(200, {
      exitCode: timedOut || result.killed ? null : result.exitCode,
      stdout: new TextDecoder().decode(Buffer.concat(stdout.map((chunk) => Buffer.from(chunk)))),
      stderr: '',
    });
  }

  function files(record: Held, method: string, url: URL, init: RequestInit): Response {
    const target = url.searchParams.get('path') ?? '';
    if (!allowed(target)) return failure(400, 'bad_path', 'path must be under /data or /home/desk');
    wake(record);
    const fs = record.sandbox.fs;
    if (method === 'GET') {
      const node = fs.stat(target);
      if (!node) return failure(404, 'not_found', 'no such file');
      if (node.kind === 'dir') return failure(400, 'bad_path', 'path is a directory');
      const bytes = fs.readFile(target);
      if (bytes.byteLength > FILE_LIMIT) return failure(413, 'too_large', 'file is above 8 MiB');
      return new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    }
    if (method === 'PUT') {
      const bytes = bodyBytes(init.body);
      if (bytes.byteLength > FILE_LIMIT) return failure(413, 'too_large', 'file is above 8 MiB');
      try {
        fs.writeFile(target, bytes, { parents: true });
      } catch (error) {
        if (error instanceof FsError) return failure(400, 'bad_path', error.message);
        throw error;
      }
      return json(200, { path: target, size: bytes.byteLength });
    }
    return failure(405, 'method_not_allowed', 'no such route');
  }

  async function route(method: string, url: URL, init: RequestInit): Promise<Response> {
    const path = url.pathname.slice(PREFIX.length);
    const parts = path.split('/').filter(Boolean);
    if (!parts.length && method === 'POST') return create(init);
    if (!parts.length && method === 'GET') {
      const wanted = url.searchParams.get('externalUserId');
      return json(200, {
        computers: [...records.values()]
          .filter((record) => wanted === null || record.externalUserId === wanted)
          .map(out),
      });
    }
    const record = records.get(parts[0] ?? '');
    if (!record) return failure(404, 'not_found', 'computer not found');
    const action = parts.slice(1).join('/');
    if (!action && method === 'GET') return json(200, out(record));
    if (!action && method === 'DELETE') {
      engine.destroy(record.sandbox.id);
      records.delete(record.sandbox.id);
      return new Response(null, { status: 204 });
    }
    if (action === 'wake' && method === 'POST') {
      const method_ = record.status === 'asleep' ? 'resume' : 'already_awake';
      wake(record);
      return json(200, { status: 'awake', wakeMs: 0, method: method_ });
    }
    if (action === 'sleep' && method === 'POST') {
      if (refuseSleep) {
        refuseSleep = false;
        return failure(409, 'human_in_control', 'a person is controlling this computer');
      }
      // The memory is snapshotted: what runs is held, not ended.
      record.status = 'asleep';
      record.sandbox.state = 'paused';
      return json(200, out(record));
    }
    if (action === 'exec' && method === 'POST') return exec(record, init);
    if (action === 'files') return files(record, method, url, init);
    if (action === 'actions' && method === 'POST') {
      if (holding(record.sandbox.id))
        return failure(409, 'human_in_control', 'a person holds the desktop', 15);
      wake(record);
      const body = JSON.parse(new TextDecoder().decode(bodyBytes(init.body)) || '{}') as {
        action?: unknown;
        actions?: { action?: unknown }[];
      };
      acted.push({
        id: record.sandbox.id,
        actions: (Array.isArray(body.actions) ? body.actions : [body]) as Record<string, unknown>[],
      });
      const one = (request: { action?: unknown }) =>
        typeof request.action === 'string'
          ? { action: request.action, ok: true, isError: false }
          : null;
      if (Array.isArray(body.actions)) {
        const results = body.actions.map(one);
        if (results.includes(null) || results.length > 50)
          return failure(400, 'unknown_action', 'every action needs a name');
        return json(200, { results });
      }
      const result = one(body);
      return result ? json(200, result) : failure(400, 'unknown_action', 'action is required');
    }
    if (action === 'screenshot' && method === 'GET') {
      wake(record);
      return new Response(frame ? pngOfSize(frame.width, frame.height) : PIXEL, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'x-frame-id': '1',
          'x-screen-width': '1200',
          'x-screen-height': '750',
        },
      });
    }
    if (action === 'sessions/close' && method === 'POST') {
      // Every viewer link of the session is revoked with it. As on Maritime, a person
      // holding the desktop keeps it until they press Done in the viewer.
      closed.push(record.sandbox.id);
      return json(200, { closed: true });
    }
    if (action === 'viewer' && method === 'POST') {
      const body = JSON.parse(new TextDecoder().decode(bodyBytes(init.body)) || '{}') as {
        mode?: unknown;
        ttlS?: unknown;
      };
      const mode = body.mode ?? 'watch';
      if (mode !== 'watch' && mode !== 'control')
        return failure(422, 'validation', 'mode is watch or control');
      const ttlS = typeof body.ttlS === 'number' ? body.ttlS : null;
      const lasts = (ttlS ?? 600) * 1000;
      viewers += 1;
      minted.push({ id: record.sandbox.id, mode, ttlS });
      // A link to drive it holds the desktop from now, opened or not, and replaces the one before.
      if (mode === 'control') held.set(record.sandbox.id, now() + lasts + RELEASE_GRACE_MS);
      return json(200, {
        url: `https://maritime.sh/view/standin-${String(viewers).padStart(4, '0')}`,
        expiresAt: new Date(now() + lasts).toISOString(),
        mode,
      });
    }
    return failure(404, 'not_found', `no route ${method} ${path}`);
  }

  const standinFetch: Fetch = async (input, init = {}) => {
    if (input instanceof Request) throw new Error('the stand-in takes URL requests');
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    init.signal?.throwIfAborted();
    if (new Headers(init.headers).get('authorization') !== `Bearer ${AUTHORING_KEY}`)
      return failure(401, 'unauthorized', 'invalid API key');
    if (!url.href.startsWith(`${MARITIME_API_URL}${PREFIX}`))
      return new Response('unknown host', { status: 404 });
    return route(method, url, init);
  };

  return {
    fetch: standinFetch,
    engine,
    records,
    /** The next sleep is refused the way Maritime refuses one while a person holds the computer. */
    refuseNextSleep() {
      refuseSleep = true;
    },
    acted,
    closed,
    minted,
    /** A person takes the desktop through a control link until they let it go, or lets it go (Done). */
    hold(id: string, on = true) {
      if (on) held.set(id, Number.POSITIVE_INFINITY);
      else held.delete(id);
    },
    /** Screenshots come back at this size from now on. */
    frame(width: number, height: number) {
      frame = { width, height };
    },
  };
}
