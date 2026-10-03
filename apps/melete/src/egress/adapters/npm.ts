/**
 * The npm registry for the agent's computer: what `npm` speaks to
 * registry.npmjs.org.
 *
 * Reads go out with the person's token: installs, views, searches, and the
 * audit lookups npm sends as POSTs although they change nothing. Everything
 * else is a write that asks first, bound to the exact request:
 *
 * - a publish, to the package, each version it adds, its tags and its access,
 *   and the exact bytes of the tarball it carries;
 * - an unpublish, a deprecation, a maintainer change or any other change to a
 *   package's record, shown as each field will be afterwards;
 * - a dist-tag, access, team or organisation change, by what it names.
 *
 * Unknown means write: any method other than GET or HEAD outside the short
 * list of reads asks, and a request this adapter cannot read asks as itself.
 */
import { createHash } from 'node:crypto';
import type { JsonObject } from '@melete/contracts';
import { z } from 'zod';
import { canonicalBody, requestWrite, shownBody, shownText } from './generic.ts';
import { jsonObject, kib, str } from './github.ts';
import type {
  CardSummary,
  Classification,
  ClassifiedWrite,
  CredentialAdapter,
  InterceptedRequest,
  OutboundRequest,
  UpstreamResponse,
} from './types.ts';

export const NPM_REGISTRY_HOST = 'registry.npmjs.org';

/** What the computer's commands see in place of the token. */
export const NPM_TOKEN_PLACEHOLDER = 'melete-proxy-adds-this';
/**
 * Where the placeholder reaches npm: the computer's global npm settings name
 * the public registry's token as this variable (`NPM_RC_LINE`), so npm sends
 * it, and the relay puts the account in its place. A registry-scoped setting
 * cannot travel as an environment variable itself: its name is not one a
 * shell passes on.
 */
export const NPM_TOKEN_ENV = 'NPM_TOKEN';
/** The line of the computer's global npmrc that reads the token from `NPM_TOKEN`, when set. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: npm expands it when it reads the file.
export const NPM_RC_LINE = '//registry.npmjs.org/:_authToken=${NPM_TOKEN?}';

/** The configuration an npm account keeps beside its sealed token: nothing yet. */
export const npmAdapterConfig = z.strictObject({});
export type NpmAdapterConfig = z.infer<typeof npmAdapterConfig>;

const READS = new Set(['GET', 'HEAD']);
/** The audit lookups `npm install` and `npm audit` send: a list of packages in, advisories out. */
const READ_POSTS = new Set([
  '/-/npm/v1/security/advisories/bulk',
  '/-/npm/v1/security/audits/quick',
  '/-/npm/v1/security/audits',
]);

/** A package name as the registry allows it, scoped or not. */
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._~-]{0,213}\/)?[a-z0-9_][a-z0-9._~-]{0,213}$/i;
const plainPackage = (name: string) =>
  PACKAGE.test(name) && !name.split('/').some((part) => part === '.' || part === '..');
const ORG = /^[a-z0-9][a-z0-9._~-]{0,213}$/i;

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/**
 * The segments of a path, each unescaped once, or null when one could be read
 * two ways: an empty or dot segment, a backslash, or an escape that does not
 * decode.
 */
function segments(path: string): string[] | null {
  if (!path.startsWith('/') || path.includes('\\') || /%5c/i.test(path)) return null;
  const out: string[] = [];
  for (const part of path.slice(1).split('/')) {
    let plain: string;
    try {
      plain = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (!plain || plain === '.' || plain === '..' || plain.includes('\\')) return null;
    out.push(plain);
  }
  return out;
}

/** A package named at `parts[index]`: `name`, `@scope/name` or `@scope%2fname`. */
function packageAt(parts: string[], index: number): { name: string; next: number } | null {
  const first = parts[index];
  if (!first) return null;
  if (first.startsWith('@')) {
    // An escaped scope arrives whole in one segment; an unescaped one spans two.
    const whole = first.includes('/');
    const name = whole ? first : `${first}/${parts[index + 1] ?? ''}`;
    return plainPackage(name) ? { name, next: index + (whole ? 1 : 2) } : null;
  }
  return plainPackage(first) ? { name: first, next: index + 1 } : null;
}

/** A generic write, with the package it names when it names one. */
function generic(request: InterceptedRequest, pkg?: string): Classification {
  const write = requestWrite(request);
  if (write.kind !== 'write' || !pkg) return write;
  return { ...write, payload: { ...write.payload, resource: pkg } };
}

type Write = Extract<Classification, { kind: 'write' }>;

/** A write with its card. The relay binds the request's exact body bytes beside it. */
function write(
  request: InterceptedRequest,
  operation: string,
  pkg: string | undefined,
  summary: CardSummary,
  destructive: boolean,
  extra: JsonObject = {},
): Write {
  const body = canonicalBody(request);
  return {
    kind: 'write',
    operation,
    payload: {
      site: NPM_REGISTRY_HOST,
      method: request.method,
      url_path: request.path,
      query: request.query,
      ...(pkg ? { resource: pkg } : {}),
      ...extra,
      // A publish carries its tarball inside the JSON: the digest stands for it here.
      body: 'json' in body ? { bytes: body.bytes ?? 0, sha256: body.sha256 ?? null } : body,
    },
    summary: {
      ...summary,
      facts: [
        ...summary.facts,
        {
          label: 'Request',
          value: `${request.method} https://${NPM_REGISTRY_HOST}${request.path}${request.query ? `?${request.query}` : ''}`,
        },
      ],
    },
    destructive,
  };
}

const listed = (names: string[], max = 10) =>
  names.length > max
    ? `${names.slice(0, max).join(', ')} and ${names.length - max} more`
    : names.join(', ');

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Scripts npm runs when someone installs the package. */
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];

/** A publish: the versions it adds, as their manifests say, and the tarballs it carries. */
function publish(request: InterceptedRequest, pkg: string, doc: Record<string, unknown>): Write {
  const versions = record(doc.versions);
  const tags = record(doc['dist-tags']);
  const numbers = Object.keys(versions).sort();
  const tagged = Object.entries(tags)
    .map(([tag, version]) => `${tag} → ${String(version)}`)
    .sort();
  const tarballs = Object.entries(record(doc._attachments)).map(([file, value]) => {
    const item = record(value);
    const data = typeof item.data === 'string' ? Buffer.from(item.data, 'base64') : Buffer.alloc(0);
    return { file, bytes: data.length, sha256: sha256(data) };
  });
  const facts: CardSummary['facts'] = [
    { label: 'Package', value: pkg },
    { label: 'Versions', value: numbers.join(', ') || 'none named' },
    { label: 'Tags', value: tagged.join(', ') || 'none' },
  ];
  if (typeof doc.access === 'string') facts.push({ label: 'Access', value: doc.access });
  for (const version of numbers) {
    const manifest = record(versions[version]);
    const scripts = record(manifest.scripts);
    const run = INSTALL_SCRIPTS.filter((name) => typeof scripts[name] === 'string');
    if (run.length)
      facts.push({
        label: `Scripts that run on install (${version})`,
        value: run.map((name) => `${name}: ${String(scripts[name])}`).join('\n'),
      });
    const dist = record(manifest.dist);
    if (typeof dist.integrity === 'string')
      facts.push({ label: `Integrity (${version})`, value: dist.integrity.slice(0, 200) });
  }
  for (const tarball of tarballs)
    facts.push({ label: 'Tarball', value: `${tarball.file}, ${kib(tarball.bytes)}` });
  const manifests = Object.fromEntries(
    numbers.map((version) => {
      const { readme: _readme, ...rest } = record(versions[version]);
      return [version, rest];
    }),
  );
  facts.push({ label: 'Details', value: shownText(JSON.stringify(manifests, null, 2)) });
  const named = numbers.length === 1 ? `${pkg}@${numbers[0]}` : `${pkg} (${numbers.join(', ')})`;
  const tagNames = Object.keys(tags).sort().join(', ');
  return write(
    request,
    'publish',
    pkg,
    {
      title: `Publish ${named} to npm${tagNames ? ` (tag ${tagNames})` : ''}${doc.access === 'public' ? ', public' : ''}`,
      facts,
    },
    false,
    {
      publish: {
        versions: numbers,
        dist_tags: Object.fromEntries(
          Object.entries(tags).map(([tag, version]) => [tag, String(version)]),
        ),
        access: typeof doc.access === 'string' ? doc.access : null,
        tarballs,
      },
    },
  );
}

/**
 * Any other change to a package's record (an unpublish of one version, a
 * deprecation, a maintainer change, a star): each field the document names
 * replaces that field, so the card shows each one as it will be afterwards.
 */
function rewrite(request: InterceptedRequest, pkg: string, doc: Record<string, unknown>): Write {
  const parts: string[] = [];
  const facts: CardSummary['facts'] = [{ label: 'Package', value: pkg }];
  if ('versions' in doc) {
    const versions = record(doc.versions);
    const numbers = Object.keys(versions).sort();
    parts.push(`versions kept: ${listed(numbers, 5) || 'none'}`);
    facts.push({ label: 'Versions afterwards', value: listed(numbers) || 'none' });
    const deprecated = numbers.flatMap((version) => {
      const note = record(versions[version]).deprecated;
      return typeof note === 'string' && note ? [`${version}: ${note.slice(0, 200)}`] : [];
    });
    if (deprecated.length) {
      parts.push(`${deprecated.length} deprecated`);
      facts.push({ label: 'Deprecated', value: deprecated.join('\n') });
    }
  }
  if ('maintainers' in doc) {
    const maintainers = (Array.isArray(doc.maintainers) ? doc.maintainers : [])
      .map((entry) => str(record(entry).name, 214))
      .filter((name): name is string => Boolean(name));
    parts.push(`maintainers: ${listed(maintainers, 5) || 'none'}`);
    facts.push({ label: 'Maintainers afterwards', value: listed(maintainers) || 'none' });
  }
  if ('dist-tags' in doc) {
    const tags = Object.entries(record(doc['dist-tags'])).map(
      ([tag, version]) => `${tag} → ${String(version)}`,
    );
    parts.push('tags');
    facts.push({ label: 'Tags afterwards', value: tags.join(', ') || 'none' });
  }
  const others = Object.keys(doc).filter(
    (key) => !['_id', '_rev', 'name', 'versions', 'maintainers', 'dist-tags'].includes(key),
  );
  if (others.length) parts.push(others.slice(0, 5).join(', '));
  facts.push({ label: 'Details', value: shownBody(request, canonicalBody(request)) });
  return write(
    request,
    'package_record',
    pkg,
    { title: `Change ${pkg} on npm (${parts.join('; ') || 'its record'})`, facts },
    // Versions, maintainers and tags left out of the lists the document names are removed.
    'versions' in doc || 'maintainers' in doc || 'dist-tags' in doc,
  );
}

/** Requests under `/-/package/<name>/`: dist-tags and access. */
function packageSettings(request: InterceptedRequest, parts: string[]): Classification {
  const found = packageAt(parts, 2);
  if (!found) return generic(request);
  const { name: pkg, next } = found;
  const rest = parts.slice(next);
  if (rest[0] === 'dist-tags' && rest.length === 2) {
    const tag = rest[1] ?? '';
    if (request.method === 'PUT' || request.method === 'POST') {
      let version: unknown = null;
      try {
        version = JSON.parse(request.body.toString('utf8'));
      } catch {
        return generic(request, pkg);
      }
      if (typeof version !== 'string') return generic(request, pkg);
      return write(
        request,
        'dist_tag',
        pkg,
        {
          title: `Point the ${tag} tag of ${pkg} at ${version.slice(0, 100)}`,
          facts: [
            { label: 'Package', value: pkg },
            { label: 'Tag', value: `${tag} → ${version.slice(0, 100)}` },
          ],
        },
        // It replaces whatever the tag named, and `latest` is what everyone installs.
        true,
        { dist_tag: { tag, version } },
      );
    }
    if (request.method === 'DELETE')
      return write(
        request,
        'dist_tag',
        pkg,
        { title: `Remove the ${tag} tag from ${pkg}`, facts: [{ label: 'Package', value: pkg }] },
        true,
        { dist_tag: { tag, version: null } },
      );
  }
  const doc = jsonObject(request.body);
  if (rest[0] === 'access' && rest.length === 1 && request.method === 'POST' && doc) {
    const access = str(doc.access, 40);
    const tfa = doc.publish_requires_tfa;
    const title =
      access === 'public'
        ? `Make ${pkg} public`
        : access === 'restricted'
          ? `Make ${pkg} private`
          : tfa === true
            ? `Require two-factor authentication to publish ${pkg}`
            : tfa === false
              ? `Stop requiring two-factor authentication to publish ${pkg}`
              : `Change who can publish ${pkg}`;
    return write(
      request,
      'access',
      pkg,
      {
        title,
        facts: [
          { label: 'Package', value: pkg },
          { label: 'Details', value: shownBody(request, canonicalBody(request)) },
        ],
      },
      true,
    );
  }
  return generic(request, pkg);
}

/** Requests under `/-/`: teams, organisations, and anything else the registry serves there. */
function registrySettings(request: InterceptedRequest, parts: string[]): Classification {
  if (parts[1] === 'package') return packageSettings(request, parts);
  const doc = jsonObject(request.body) ?? {};
  // A team's access to a package: /-/team/<org>/<team>/package.
  if (parts[1] === 'team' && parts.length === 5 && parts[4] === 'package') {
    const team = `@${parts[2]}:${parts[3]}`;
    const pkg = str(doc.package, 214);
    const named = pkg && plainPackage(pkg) ? pkg : undefined;
    if (request.method === 'PUT')
      return write(
        request,
        'team_access',
        named,
        {
          title: `Give the team ${team} ${str(doc.permissions, 40) ?? 'access'} on ${named ?? 'a package'}`,
          facts: [{ label: 'Team', value: team }],
        },
        true,
      );
    if (request.method === 'DELETE')
      return write(
        request,
        'team_access',
        named,
        {
          title: `Take away the team ${team}'s access to ${named ?? 'a package'}`,
          facts: [{ label: 'Team', value: team }],
        },
        true,
      );
  }
  // Members of an organisation: /-/org/<org>/user.
  const org = parts[2] ?? '';
  if (parts[1] === 'org' && parts.length === 4 && parts[3] === 'user' && ORG.test(org)) {
    const user = str(doc.user, 214) ?? 'someone';
    const role = str(doc.role, 40);
    if (request.method === 'PUT')
      return write(
        request,
        'org_member',
        undefined,
        {
          title: `Add ${user} to the npm organisation ${org}${role ? ` as ${role}` : ''}`,
          facts: [{ label: 'Organisation', value: org }],
        },
        true,
      );
    if (request.method === 'DELETE')
      return write(
        request,
        'org_member',
        undefined,
        {
          title: `Remove ${user} from the npm organisation ${org}`,
          facts: [{ label: 'Organisation', value: org }],
        },
        true,
      );
  }
  return generic(request);
}

function classifyRegistry(request: InterceptedRequest): Classification {
  if (READS.has(request.method)) return { kind: 'read' };
  if (request.method === 'POST' && READ_POSTS.has(request.path) && !request.query)
    return { kind: 'read' };
  // A compressed or otherwise encoded body is not read here: it asks as itself.
  if (request.headers['content-encoding']) return generic(request);
  const parts = segments(request.path);
  if (!parts) return generic(request);
  if (parts[0] === '-') return registrySettings(request, parts);
  const found = packageAt(parts, 0);
  if (!found) return generic(request);
  const { name: pkg, next } = found;
  const rest = parts.slice(next);
  if (request.query) return generic(request, pkg);
  const doc = jsonObject(request.body);
  const toRecord = rest.length === 0 || (rest.length === 2 && rest[0] === '-rev');
  if (request.method === 'PUT' && doc && toRecord) {
    // The document must name the package it is sent to; one that names another asks as itself.
    if (doc.name !== undefined && doc.name !== pkg) return generic(request, pkg);
    const carries = Object.keys(record(doc._attachments)).length > 0;
    return carries && rest.length === 0 && doc._rev === undefined
      ? publish(request, pkg, doc)
      : rewrite(request, pkg, doc);
  }
  if (request.method === 'DELETE' && rest.length === 2 && rest[0] === '-rev')
    return write(
      request,
      'unpublish',
      pkg,
      {
        title: `Unpublish every version of ${pkg} from npm`,
        facts: [{ label: 'Package', value: pkg }],
      },
      true,
    );
  if (request.method === 'DELETE' && rest.length === 4 && rest[0] === '-' && rest[2] === '-rev')
    return write(
      request,
      'unpublish',
      pkg,
      {
        title: `Delete the tarball ${rest[1]} of ${pkg} from npm`,
        facts: [{ label: 'Package', value: pkg }],
      },
      true,
    );
  return generic(request, pkg);
}

// ---------------------------------------------------------------- receipts and answers

function receipt(write: ClassifiedWrite, upstream: UpstreamResponse): JsonObject {
  const answer = jsonObject(upstream.body);
  return {
    package: typeof write.payload.resource === 'string' ? write.payload.resource : null,
    ...(typeof answer?.success === 'boolean' ? { success: answer.success } : {}),
    ...(answer && 'ok' in answer ? { ok: Boolean(answer.ok) } : {}),
  };
}

function heldAnswer(
  _request: InterceptedRequest,
  _write: ClassifiedWrite,
  message: string,
  status: number,
): UpstreamResponse | null {
  // npm prints the `error` of a JSON answer after the status line.
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: Buffer.from(JSON.stringify({ error: message, message })),
  };
}

// ---------------------------------------------------------------- the adapter

export const npmAdapter: CredentialAdapter<NpmAdapterConfig> = {
  id: 'npm',
  constraints: [NPM_REGISTRY_HOST],
  parseConfig: (value) => npmAdapterConfig.parse(value ?? {}),
  hosts: () => [NPM_REGISTRY_HOST],
  placeholders: () => ({ [NPM_TOKEN_ENV]: NPM_TOKEN_PLACEHOLDER }),
  standIns: () => [NPM_TOKEN_PLACEHOLDER],
  classify(request) {
    if (request.host !== NPM_REGISTRY_HOST)
      return {
        kind: 'refuse',
        reason: `${request.host} is not the npm registry this account covers.`,
      };
    return classifyRegistry(request);
  },
  authorize: (request: OutboundRequest, secret: string): OutboundRequest => ({
    ...request,
    headers: { ...request.headers, authorization: `Bearer ${secret}` },
  }),
  redactions: (secret) => [secret, Buffer.from(secret).toString('base64')],
  receipt,
  heldAnswer,
};

/** What the registry says about a token: the account it belongs to, or why it was refused. */
export type NpmAccountCheck =
  | { ok: true; login: string }
  | { ok: false; code: 'credential_refused' | 'unavailable' };

/**
 * Asks the registry whose token this is (`GET /-/whoami`), from the service.
 * The token goes only to registry.npmjs.org, or to the address a test names.
 */
export async function npmAccount(
  token: string,
  options: { fetch?: typeof fetch; registry?: string; signal?: AbortSignal } = {},
): Promise<NpmAccountCheck> {
  const call = options.fetch ?? fetch;
  try {
    const response = await call(`${options.registry ?? `https://${NPM_REGISTRY_HOST}`}/-/whoami`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'user-agent': 'Melete',
      },
      redirect: 'error',
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      return { ok: false, code: 'credential_refused' };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, code: 'unavailable' };
    }
    const user = (await response.json()) as { username?: unknown };
    return typeof user.username === 'string' && /^[A-Za-z0-9._~-]{1,214}$/.test(user.username)
      ? { ok: true, login: user.username }
      : { ok: false, code: 'unavailable' };
  } catch {
    return { ok: false, code: 'unavailable' };
  }
}
