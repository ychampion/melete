/**
 * GitHub for the agent's computer: `git` over smart HTTP on github.com, the
 * REST and GraphQL APIs on api.github.com (what `gh` speaks), and downloads
 * from GitHub's file hosts.
 *
 * Reads go out with the person's token. Everything else is a write that asks
 * first, bound to exactly what it does:
 *
 * - a push (`git-receive-pack`) to its repository and each ref update, old
 *   and new commit, which name their content by hash;
 * - a REST call to its method, path, query and body;
 * - a GraphQL document with any mutation in it to its exact document and
 *   variables.
 *
 * Unknown means write: a request this adapter cannot read, a GraphQL document
 * that does not parse, a push whose commands are not exactly readable and any
 * method other than GET or HEAD outside a short list of reads all ask. The
 * file hosts are read only; a change sent there is refused.
 */
import { createHash } from 'node:crypto';
import { canonicalizePayload, type JsonObject, type JsonValue } from '@melete/contracts';
import { type DocumentNode, Kind, type OperationDefinitionNode, parse, print } from 'graphql';
import { z } from 'zod';
import {
  isZeroId,
  parseReceivePack,
  parseReportStatus,
  type ReceivePackCommands,
  refusedPushAnswer,
} from '../git-pktline.ts';
import { canonicalBody, requestWrite, shownBody, shownText } from './generic.ts';
import type {
  CardSummary,
  Classification,
  ClassifiedWrite,
  CredentialAdapter,
  InterceptedRequest,
  OutboundRequest,
  UpstreamResponse,
} from './types.ts';
import { hostCovered } from './types.ts';

export const GIT_HOST = 'github.com';
export const API_HOST = 'api.github.com';
/** File hosts: downloads only. */
export const READ_ONLY_HOSTS = [
  'codeload.github.com',
  'uploads.github.com',
  'raw.githubusercontent.com',
] as const;
export const GITHUB_HOSTS = [GIT_HOST, API_HOST, ...READ_ONLY_HOSTS];

/** What the computer's commands see in place of the token. */
export const GITHUB_TOKEN_PLACEHOLDER = 'melete-proxy-adds-this';

/** The configuration a GitHub account keeps beside its sealed token: nothing yet. */
export const githubAdapterConfig = z.strictObject({});
export type GithubAdapterConfig = z.infer<typeof githubAdapterConfig>;

const READS = new Set(['GET', 'HEAD']);
/** REST calls that change nothing although they are POSTs. */
const API_READ_POSTS = new Set(['/markdown', '/markdown/raw']);
/** An owner or repository name as GitHub allows it, and nothing a path could be read two ways in. */
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const plainName = (value: string) => NAME.test(value) && value !== '.' && value !== '..';
/**
 * Paths whose segments say exactly where they go: no dot segments, empty
 * segments, backslashes or escaped dots. An escaped `/` stays inside its
 * segment (a branch name in a ref path); the owner and repository segments
 * are checked as plain names on their own.
 */
const canonicalPath = (path: string) =>
  path.startsWith('/') &&
  !path.includes('//') &&
  !path.includes('\\') &&
  !/%(?:2e|5c)/i.test(path) &&
  !path.split('/').some((segment) => segment === '.' || segment === '..');

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const short = (id: string) => id.slice(0, 7);
/** A ref as a person reads it: a branch by its name, a tag as a tag. */
export function refName(ref: string): string {
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  if (ref.startsWith('refs/tags/')) return `tag ${ref.slice('refs/tags/'.length)}`;
  return ref;
}
const decoded = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};
const kib = (bytes: number) =>
  bytes < 1024
    ? `${bytes} bytes`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** The JSON object a body holds, or null. */
function jsonObject(body: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
const str = (value: unknown, max = 200) =>
  typeof value === 'string' ? value.slice(0, max) : undefined;
const canonical = (value: unknown): JsonValue =>
  canonicalizePayload({ value: (value ?? null) as JsonValue }).canonical.value ?? null;

/** A generic write, with the repository it names when it names one. */
function generic(request: InterceptedRequest, repository?: string): Classification {
  const write = requestWrite(request);
  if (write.kind !== 'write' || !repository) return write;
  return { ...write, payload: { ...write.payload, resource: repository } };
}

// ---------------------------------------------------------------- git on github.com

const GIT_REPO = /^\/([^/]+)\/([^/]+?)(?:\.git)?(\/.*)?$/;

function pushSummary(repository: string, commands: ReceivePackCommands): CardSummary {
  const names = commands.updates.map((update) => refName(update.ref));
  const listed =
    names.length > 5
      ? `${names.slice(0, 5).join(', ')} and ${names.length - 5} more`
      : names.join(', ');
  const deletes = commands.updates.every((update) => isZeroId(update.new));
  return {
    title: deletes ? `Delete ${listed} in ${repository}` : `Push to ${repository} (${listed})`,
    facts: [
      { label: 'Repository', value: repository },
      ...commands.updates.map((update) => ({
        label: refName(update.ref),
        value: isZeroId(update.new)
          ? `delete (was ${short(update.old)})`
          : isZeroId(update.old)
            ? `new ${update.ref.startsWith('refs/tags/') ? 'tag' : 'branch'} at ${short(update.new)}`
            : `update ${short(update.old)} → ${short(update.new)}`,
      })),
      ...(commands.pushOptions.length
        ? [{ label: 'Push options', value: commands.pushOptions.join('\n') }]
        : []),
      ...(commands.capabilities.includes('atomic')
        ? [{ label: 'All or nothing', value: 'Every ref above is updated, or none is.' }]
        : []),
    ],
  };
}

/** Capabilities that change what a push does; the client's name and session say nothing about it. */
const boundCapabilities = (capabilities: string[]) =>
  capabilities.filter((cap) => !cap.startsWith('agent=') && !cap.startsWith('session-id=')).sort();

function classifyPush(request: InterceptedRequest, repository: string): Classification {
  // A compressed or otherwise encoded body is not read here: it asks as itself.
  if (request.headers['content-encoding'] || request.query) return generic(request, repository);
  const commands = parseReceivePack(request.body);
  if (!commands) return generic(request, repository);
  // Only a flush: git's probe before a large push, which changes nothing.
  if (commands.updates.length === 0) return { kind: 'read' };
  const head = request.body.subarray(0, commands.length);
  return {
    kind: 'write',
    operation: 'push',
    payload: {
      site: GIT_HOST,
      resource: repository,
      updates: commands.updates.map((update) => ({ ...update })),
      push_options: commands.pushOptions,
      capabilities: boundCapabilities(commands.capabilities),
      shallow: commands.shallow,
    },
    summary: pushSummary(repository, commands),
    destructive: commands.updates.some((update) => isZeroId(update.new)),
    boundBody: { commands_sha256: sha256(head), commands_bytes: head.length },
  };
}

function classifyLfsBatch(request: InterceptedRequest, repository: string): Classification {
  const batch = jsonObject(request.body);
  if (batch?.operation === 'download') return { kind: 'read' };
  const objects = Array.isArray(batch?.objects) ? batch.objects : null;
  if (batch?.operation !== 'upload' || !objects) return generic(request, repository);
  const listed = objects.map((item) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    return { oid: String(entry.oid ?? ''), size: Number(entry.size ?? 0) };
  });
  const total = listed.reduce((sum, item) => sum + (Number.isFinite(item.size) ? item.size : 0), 0);
  return {
    kind: 'write',
    operation: 'lfs_upload',
    payload: {
      site: GIT_HOST,
      resource: repository,
      lfs: {
        operation: 'upload',
        ref: canonical(batch.ref),
        objects: listed.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0)),
      },
      body: canonicalBody(request),
    },
    summary: {
      title: `Upload ${listed.length} large ${listed.length === 1 ? 'file' : 'files'} to ${repository} (${kib(total)})`,
      facts: [
        { label: 'Repository', value: repository },
        { label: 'Details', value: shownBody(request, canonicalBody(request)) },
      ],
    },
    destructive: false,
  };
}

function classifyGit(request: InterceptedRequest): Classification {
  if (READS.has(request.method)) return { kind: 'read' };
  const match = canonicalPath(request.path) ? GIT_REPO.exec(request.path) : null;
  const owner = match?.[1] ?? '';
  const name = match?.[2] ?? '';
  if (!match || !plainName(owner) || !plainName(name)) return generic(request);
  const repository = `${owner}/${name}`;
  const rest = match[3] ?? '';
  if (request.method === 'POST' && rest === '/git-upload-pack' && !request.query)
    return { kind: 'read' };
  if (request.method === 'POST' && rest === '/git-receive-pack')
    return classifyPush(request, repository);
  if (request.method === 'POST' && rest === '/info/lfs/objects/batch' && !request.query)
    return classifyLfsBatch(request, repository);
  // Asks which locks are held; it changes none.
  if (request.method === 'POST' && rest === '/info/lfs/locks/verify' && !request.query)
    return { kind: 'read' };
  return generic(request, repository);
}

// ---------------------------------------------------------------- GraphQL

type Graphql = { query: string; variables: unknown; operationName: string | null };

function graphqlRequest(request: InterceptedRequest): Graphql | null {
  if (READS.has(request.method)) {
    const params = new URLSearchParams(request.query);
    const query = params.get('query');
    if (query === null) return null;
    let variables: unknown = null;
    const raw = params.get('variables');
    if (raw !== null) {
      try {
        variables = JSON.parse(raw);
      } catch {
        return null;
      }
    }
    return { query, variables, operationName: params.get('operationName') };
  }
  const body = jsonObject(request.body);
  if (!body || typeof body.query !== 'string') return null;
  if (
    body.operationName !== undefined &&
    body.operationName !== null &&
    typeof body.operationName !== 'string'
  )
    return null;
  return {
    query: body.query,
    variables: body.variables ?? null,
    operationName: (body.operationName as string | null | undefined) ?? null,
  };
}

/** The top-level fields a mutation selects, in order. */
const rootFields = (operation: OperationDefinitionNode) =>
  operation.selectionSet.selections.flatMap((selection) =>
    selection.kind === Kind.FIELD ? [selection.name.value] : [],
  );

function inputOf(variables: unknown): Record<string, unknown> {
  const all = (variables ?? {}) as Record<string, unknown>;
  const input = all.input;
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : all;
}

const REVIEW_EVENTS: Record<string, string> = {
  APPROVE: 'approve',
  REQUEST_CHANGES: 'request changes',
  COMMENT: 'comment',
};

/** One sentence for the mutations gh makes most, from the first field and its input. */
function mutationTitle(field: string, input: Record<string, unknown>): string {
  const title = str(input.title, 120);
  switch (field) {
    case 'createPullRequest': {
      const head = str(input.headRefName, 100);
      const base = str(input.baseRefName, 100);
      return `Open a pull request${title ? `: ${title}` : ''}${head && base ? ` (${head} → ${base})` : ''}`;
    }
    case 'mergePullRequest':
      return `Merge a pull request${str(input.mergeMethod) ? ` (${String(input.mergeMethod).toLowerCase()})` : ''}`;
    case 'closePullRequest':
      return 'Close a pull request';
    case 'reopenPullRequest':
      return 'Reopen a pull request';
    case 'updatePullRequest':
      return `Change a pull request${title ? `: ${title}` : ''}`;
    case 'markPullRequestReadyForReview':
      return 'Mark a pull request ready for review';
    case 'addPullRequestReview':
      return `Review a pull request${REVIEW_EVENTS[String(input.event)] ? `: ${REVIEW_EVENTS[String(input.event)]}` : ''}`;
    case 'addComment':
      return 'Comment on an issue or pull request';
    case 'createIssue':
      return `Open an issue${title ? `: ${title}` : ''}`;
    case 'closeIssue':
      return 'Close an issue';
    case 'reopenIssue':
      return 'Reopen an issue';
    case 'updateIssue':
      return `Change an issue${title ? `: ${title}` : ''}`;
    case 'createRef':
      return `Create ${str(input.name) ? refName(String(input.name)) : 'a branch or tag'}`;
    case 'updateRef':
    case 'updateRefs':
      return 'Move a branch or tag';
    case 'deleteRef':
      return 'Delete a branch or tag';
    default:
      return `Change on GitHub: ${field}`;
  }
}

function classifyGraphql(request: InterceptedRequest): Classification {
  const fallback = () => generic(request);
  const sent = graphqlRequest(request);
  if (!sent) return fallback();
  let document: DocumentNode;
  try {
    document = parse(sent.query, { noLocation: true });
  } catch {
    return fallback();
  }
  const operations = document.definitions.filter(
    (definition): definition is OperationDefinitionNode =>
      definition.kind === Kind.OPERATION_DEFINITION,
  );
  if (!operations.length) return fallback();
  // A document that holds any mutation or subscription asks, whichever operation is named.
  const changes = operations.filter((operation) => operation.operation !== 'query');
  if (!changes.length) return { kind: 'read' };
  const fields = changes.flatMap(rootFields);
  const [first = 'mutation'] = fields;
  const input = inputOf(sent.variables);
  const variables = canonical(sent.variables);
  const destructive =
    fields.some((field) => /^(?:delete|remove)/i.test(field)) ||
    ((first === 'updateRef' || first === 'updateRefs') &&
      JSON.stringify(input).includes('"force":true'));
  const shownVariables =
    sent.variables === null ? '' : `\n\nVariables:\n${JSON.stringify(variables, null, 2)}`;
  return {
    kind: 'write',
    operation: 'graphql',
    payload: {
      site: API_HOST,
      graphql: {
        operation_name: sent.operationName ?? changes[0]?.name?.value ?? null,
        fields,
        document_sha256: sha256(print(document)),
        variables,
      },
      body: canonicalBody(request),
    },
    summary: {
      title:
        fields.length > 1
          ? `${mutationTitle(first, input)}, and ${fields.length - 1} more`
          : mutationTitle(first, input),
      facts: [
        { label: 'Request', value: `${request.method} https://${API_HOST}/graphql` },
        { label: 'Changes', value: fields.join(', ') },
        { label: 'Details', value: shownText(`${sent.query.trim()}${shownVariables}`) },
      ],
    },
    destructive,
  };
}

// ---------------------------------------------------------------- REST

type RestSummary = { title: string; destructive?: boolean };
type Route = {
  method: string;
  /** Matched against the path after `/repos/<owner>/<name>`. */
  path: RegExp;
  summary: (
    match: RegExpExecArray,
    body: Record<string, unknown>,
    repository: string,
  ) => RestSummary;
};

const REPO_ROUTES: Route[] = [
  {
    method: 'POST',
    path: /^\/pulls$/,
    summary: (_m, body, repo) => ({
      title: `Open a pull request in ${repo}${str(body.title, 120) ? `: ${str(body.title, 120)}` : ''}${
        str(body.head) && str(body.base) ? ` (${str(body.head)} → ${str(body.base)})` : ''
      }`,
    }),
  },
  {
    method: 'PUT',
    path: /^\/pulls\/(\d+)\/merge$/,
    summary: (m, body, repo) => ({
      title: `Merge pull request #${m[1]} in ${repo}${str(body.merge_method) ? ` (${str(body.merge_method)})` : ''}`,
      destructive: false,
    }),
  },
  {
    method: 'POST',
    path: /^\/pulls\/(\d+)\/reviews$/,
    summary: (m, body, repo) => ({
      title: `Review pull request #${m[1]} in ${repo}${REVIEW_EVENTS[String(body.event)] ? `: ${REVIEW_EVENTS[String(body.event)]}` : ''}`,
    }),
  },
  {
    method: 'POST',
    path: /^\/pulls\/(\d+)\/comments$/,
    summary: (m, _b, repo) => ({
      title: `Comment on the changes in pull request #${m[1]} in ${repo}`,
    }),
  },
  {
    method: 'POST',
    path: /^\/issues$/,
    summary: (_m, body, repo) => ({
      title: `Open an issue in ${repo}${str(body.title, 120) ? `: ${str(body.title, 120)}` : ''}`,
    }),
  },
  {
    method: 'POST',
    path: /^\/issues\/(\d+)\/comments$/,
    summary: (m, _b, repo) => ({ title: `Comment on #${m[1]} in ${repo}` }),
  },
  {
    method: 'PATCH',
    path: /^\/(?:issues|pulls)\/(\d+)$/,
    summary: (m, body, repo) => ({
      title:
        body.state === 'closed'
          ? `Close #${m[1]} in ${repo}`
          : body.state === 'open'
            ? `Reopen #${m[1]} in ${repo}`
            : `Change #${m[1]} in ${repo}`,
    }),
  },
  {
    method: 'POST',
    path: /^\/releases$/,
    summary: (_m, body, repo) => ({
      title:
        `${body.draft === true ? 'Draft' : 'Publish'} release ${str(body.tag_name, 100) ?? ''} in ${repo}`.replace(
          '  ',
          ' ',
        ),
    }),
  },
  {
    method: 'DELETE',
    path: /^\/releases\/(\d+)$/,
    summary: (m, _b, repo) => ({ title: `Delete release ${m[1]} in ${repo}`, destructive: true }),
  },
  {
    method: 'POST',
    path: /^\/git\/refs$/,
    summary: (_m, body, repo) => ({
      title: `Create ${str(body.ref) ? refName(String(body.ref)) : 'a ref'} in ${repo}${str(body.sha) ? ` at ${short(String(body.sha))}` : ''}`,
    }),
  },
  {
    method: 'PATCH',
    path: /^\/git\/refs\/(.+)$/,
    summary: (m, body, repo) => ({
      title: `Move ${refName(`refs/${decoded(m[1] ?? '')}`)} in ${repo}${str(body.sha) ? ` to ${short(String(body.sha))}` : ''}${body.force === true ? ', overwriting what is there' : ''}`,
      destructive: body.force === true,
    }),
  },
  {
    method: 'DELETE',
    path: /^\/git\/refs\/(.+)$/,
    summary: (m, _b, repo) => ({
      title: `Delete ${refName(`refs/${decoded(m[1] ?? '')}`)} in ${repo}`,
      destructive: true,
    }),
  },
  {
    method: 'POST',
    path: /^\/actions\/workflows\/([^/]+)\/dispatches$/,
    summary: (m, body, repo) => ({
      title: `Run workflow ${decoded(m[1] ?? '')}${str(body.ref) ? ` on ${str(body.ref)}` : ''} in ${repo}`,
    }),
  },
  {
    method: 'POST',
    path: /^\/actions\/runs\/(\d+)\/(?:rerun|rerun-failed-jobs)$/,
    summary: (m, _b, repo) => ({ title: `Re-run workflow run ${m[1]} in ${repo}` }),
  },
  {
    method: 'POST',
    path: /^\/actions\/runs\/(\d+)\/cancel$/,
    summary: (m, _b, repo) => ({ title: `Cancel workflow run ${m[1]} in ${repo}` }),
  },
  {
    method: 'PUT',
    path: /^\/contents\/(.+)$/,
    summary: (m, body, repo) => ({
      title: `Write ${decoded(m[1] ?? '')} in ${repo}${str(body.branch) ? ` on ${str(body.branch)}` : ''}`,
      destructive: true,
    }),
  },
  {
    method: 'DELETE',
    path: /^\/contents\/(.+)$/,
    summary: (m, _b, repo) => ({
      title: `Delete ${decoded(m[1] ?? '')} in ${repo}`,
      destructive: true,
    }),
  },
  {
    method: 'PUT',
    path: /^\/actions\/secrets\/([^/]+)$/,
    summary: (m, _b, repo) => ({
      title: `Set the Actions secret ${decoded(m[1] ?? '')} in ${repo}`,
      destructive: true,
    }),
  },
  {
    method: 'DELETE',
    path: /^$/,
    summary: (_m, _b, repo) => ({ title: `Delete the repository ${repo}`, destructive: true }),
  },
];

const REPO_PATH = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/;

function classifyRest(request: InterceptedRequest): Classification {
  if (READS.has(request.method)) return { kind: 'read' };
  if (request.method === 'POST' && API_READ_POSTS.has(request.path) && !request.query)
    return { kind: 'read' };
  const body = canonicalBody(request);
  const parsed = jsonObject(request.body) ?? {};
  const match = canonicalPath(request.path) ? REPO_PATH.exec(request.path) : null;
  const repository =
    match && plainName(match[1] ?? '') && plainName(match[2] ?? '')
      ? `${match[1]}/${match[2]}`
      : undefined;
  let summary: RestSummary | null = null;
  if (repository) {
    const rest = match?.[3] ?? '';
    for (const route of REPO_ROUTES) {
      if (route.method !== request.method) continue;
      const found = route.path.exec(rest);
      if (found) {
        summary = route.summary(found, parsed, repository);
        break;
      }
    }
  }
  const target = `${request.path}${request.query ? `?${request.query}` : ''}`;
  const size = request.body.length
    ? `, ${kib(request.body.length)}${'json' in body ? ' JSON' : ''}`
    : '';
  return {
    kind: 'write',
    operation: 'rest',
    payload: {
      site: API_HOST,
      method: request.method,
      url_path: request.path,
      query: request.query,
      body,
      ...(repository ? { resource: repository } : {}),
    },
    summary: {
      title: summary?.title ?? `${request.method} ${target}${size}`,
      facts: [
        { label: 'Request', value: `${request.method} https://${API_HOST}${target}` },
        { label: 'Details', value: shownBody(request, body) },
      ],
    },
    destructive: summary?.destructive ?? (request.method === 'DELETE' || request.method === 'PUT'),
  };
}

// ---------------------------------------------------------------- receipts and answers

function graphqlIds(value: unknown, found: { ids: string[]; urls: string[] }, depth = 0): void {
  if (depth > 12 || found.ids.length >= 20) return;
  if (Array.isArray(value)) {
    for (const item of value) graphqlIds(item, found, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'id' && typeof item === 'string' && found.ids.length < 20)
      found.ids.push(item.slice(0, 200));
    else if (key === 'url' && typeof item === 'string' && found.urls.length < 20)
      found.urls.push(item.slice(0, 2000));
    else graphqlIds(item, found, depth + 1);
  }
}

function receipt(write: ClassifiedWrite, upstream: UpstreamResponse): JsonObject {
  const repository = typeof write.payload.resource === 'string' ? write.payload.resource : null;
  if (write.operation === 'push') {
    const report = parseReportStatus(upstream.body);
    return {
      repository,
      unpack: report?.unpack ?? null,
      refs: (report?.refs ?? []).map((ref) => ({
        ref: ref.ref,
        ok: ref.ok,
        ...(ref.reason ? { reason: ref.reason.slice(0, 500) } : {}),
      })),
    };
  }
  const answer = jsonObject(upstream.body);
  if (write.operation === 'graphql') {
    const found = { ids: [] as string[], urls: [] as string[] };
    graphqlIds(answer?.data, found);
    return { node_ids: found.ids, urls: found.urls };
  }
  const link = str(answer?.html_url, 2000) ?? str(answer?.url, 2000) ?? null;
  return {
    repository,
    url: link,
    ...(typeof answer?.number === 'number' ? { number: answer.number } : {}),
  };
}

function rejected(write: ClassifiedWrite, upstream: UpstreamResponse): string | null {
  if (upstream.status >= 400) return null;
  if (write.operation === 'push') {
    const report = parseReportStatus(upstream.body);
    if (!report) return null;
    if (report.unpack !== 'ok')
      return `GitHub did not accept the pushed commits: ${report.unpack.slice(0, 300)}`;
    if (report.refs.length && report.refs.every((ref) => !ref.ok))
      return `GitHub rejected the push: ${report.refs
        .map((ref) => `${refName(ref.ref)}${ref.reason ? ` (${ref.reason.slice(0, 200)})` : ''}`)
        .join(', ')}`;
    return null;
  }
  if (write.operation === 'graphql') {
    const answer = jsonObject(upstream.body);
    const errors = Array.isArray(answer?.errors) ? answer.errors : [];
    const data = answer?.data as Record<string, unknown> | null | undefined;
    const landed = data && Object.values(data).some((value) => value !== null);
    if (errors.length && !landed) {
      const first = (errors[0] ?? {}) as Record<string, unknown>;
      return `GitHub refused this change: ${str(first.message, 300) ?? 'it answered with an error'}`;
    }
  }
  return null;
}

function heldAnswer(
  request: InterceptedRequest,
  write: ClassifiedWrite,
  message: string,
  status: number,
): UpstreamResponse | null {
  if (write.operation === 'push') {
    const commands = parseReceivePack(request.body);
    const body = commands ? refusedPushAnswer(commands, message) : null;
    return body
      ? {
          status: 200,
          headers: {
            'content-type': 'application/x-git-receive-pack-result',
            'cache-control': 'no-cache',
          },
          body,
        }
      : null;
  }
  // gh and git-lfs print the `message` of a JSON error.
  if (request.host === API_HOST || write.operation === 'lfs_upload')
    return {
      status,
      headers: {
        'content-type':
          write.operation === 'lfs_upload'
            ? 'application/vnd.git-lfs+json'
            : 'application/json; charset=utf-8',
      },
      body: Buffer.from(JSON.stringify({ message })),
    };
  return null;
}

// ---------------------------------------------------------------- the adapter

export const githubAdapter: CredentialAdapter<GithubAdapterConfig> = {
  id: 'github',
  constraints: [GIT_HOST, 'raw.githubusercontent.com'],
  parseConfig: (value) => githubAdapterConfig.parse(value ?? {}),
  hosts: () => [...GITHUB_HOSTS],
  placeholders: () => ({
    GH_TOKEN: GITHUB_TOKEN_PLACEHOLDER,
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
  }),
  standIns: () => [GITHUB_TOKEN_PLACEHOLDER],
  classify(request) {
    if (request.host === GIT_HOST) return classifyGit(request);
    if (request.host === API_HOST)
      return request.path === '/graphql' ? classifyGraphql(request) : classifyRest(request);
    if (hostCovered(request.host, READ_ONLY_HOSTS)) {
      if (READS.has(request.method)) return { kind: 'read' };
      return {
        kind: 'refuse',
        reason: `${request.host} is used for downloads only; changes there are not sent.`,
      };
    }
    return { kind: 'refuse', reason: `${request.host} is not a GitHub host this account covers.` };
  },
  authorize(request: OutboundRequest, secret: string): OutboundRequest {
    const authorization =
      request.host === GIT_HOST
        ? `Basic ${Buffer.from(`x-access-token:${secret}`).toString('base64')}`
        : `Bearer ${secret}`;
    return { ...request, headers: { ...request.headers, authorization } };
  },
  redactions: (secret) => [
    secret,
    Buffer.from(`x-access-token:${secret}`).toString('base64'),
    Buffer.from(secret).toString('base64'),
  ],
  receipt,
  rejected,
  heldAnswer,
};

/** What GitHub says about a token: the account it belongs to, or why it was refused. */
export type GithubAccountCheck =
  | { ok: true; login: string }
  | { ok: false; code: 'credential_refused' | 'unavailable' };

/**
 * Asks GitHub whose token this is (`GET /user`), from the service. The token
 * goes only to api.github.com, or to the address a test names.
 */
export async function githubAccount(
  token: string,
  options: { fetch?: typeof fetch; api?: string; signal?: AbortSignal } = {},
): Promise<GithubAccountCheck> {
  const call = options.fetch ?? fetch;
  try {
    const response = await call(`${options.api ?? `https://${API_HOST}`}/user`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'Melete',
        'x-github-api-version': '2022-11-28',
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
    const user = (await response.json()) as { login?: unknown };
    return typeof user.login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(user.login)
      ? { ok: true, login: user.login }
      : { ok: false, code: 'unavailable' };
  } catch {
    return { ok: false, code: 'unavailable' };
  }
}
