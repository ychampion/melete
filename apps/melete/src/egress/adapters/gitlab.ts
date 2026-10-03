/**
 * GitLab for the agent's computer: `git` over smart HTTP, the REST API under
 * `/api/v4` and the GraphQL API at `/api/graphql`, all on gitlab.com (what
 * `git` and `glab` speak).
 *
 * Reads go out with the person's token. Everything else is a write that asks
 * first, bound to exactly what it does:
 *
 * - a push (`git-receive-pack`) to its project and each ref update, old and
 *   new commit, with any push options it carries;
 * - a REST call to its method, path, query and body;
 * - a GraphQL document with any mutation in it to its exact document and
 *   variables.
 *
 * Unknown means write: a request this adapter cannot read, a GraphQL document
 * that does not parse, a push whose commands are not exactly readable and any
 * method other than GET or HEAD outside a short list of reads all ask. A
 * request that acts as another user (`Sudo`) and the command line's own usage
 * reports are refused.
 */
import { createHash } from 'node:crypto';
import { canonicalizePayload, type JsonObject, type JsonValue } from '@melete/contracts';
import { type DocumentNode, Kind, type OperationDefinitionNode, parse, print } from 'graphql';
import { z } from 'zod';
import { parseReceivePack, parseReportStatus, refusedPushAnswer } from '../git-pktline.ts';
import { canonicalBody, requestWrite, shownBody, shownText } from './generic.ts';
import {
  classifyLfsBatch,
  classifyPush,
  decoded,
  graphqlRequest,
  inputOf,
  jsonObject,
  kib,
  refName,
  rootFields,
  str,
} from './github.ts';
import type {
  Classification,
  ClassifiedWrite,
  CredentialAdapter,
  InterceptedRequest,
  OutboundRequest,
  UpstreamResponse,
} from './types.ts';

export const GITLAB_HOST = 'gitlab.com';

/** What the computer's commands see in place of the token. */
export const GITLAB_TOKEN_PLACEHOLDER = 'melete-proxy-adds-this';

/** The configuration a GitLab account keeps beside its sealed token: nothing yet. */
export const gitlabAdapterConfig = z.strictObject({});
export type GitlabAdapterConfig = z.infer<typeof gitlabAdapterConfig>;

const READS = new Set(['GET', 'HEAD']);
/** REST calls that change nothing although they are POSTs. */
const API_READ_POSTS = new Set(['/api/v4/markdown']);
/** A group, subgroup or project path segment as GitLab allows it. */
const SEGMENT = /^[A-Za-z0-9_.-]{1,255}$/;
const plainSegment = (value: string) =>
  SEGMENT.test(value) && value !== '.' && value !== '..' && !value.endsWith('.git');
/** A project path: a namespace (groups and subgroups, up to 20 deep) and a name. */
const plainProject = (value: string) => {
  const segments = value.split('/');
  return segments.length >= 2 && segments.length <= 21 && segments.every(plainSegment);
};
/**
 * Whether a path says exactly where it goes once GitLab decodes it: no empty
 * segments, backslashes, or dot segments, escaped or not. An escaped `/`
 * stays inside its segment (a project path, a file path or a branch name),
 * so each decoded segment is checked for dot parts as well.
 */
const canonicalPath = (path: string) =>
  path.startsWith('/') &&
  !path.includes('//') &&
  !path.includes('\\') &&
  !/%5c/i.test(path) &&
  path
    .split('/')
    .slice(1)
    .every((segment) => {
      const plain = decoded(segment);
      return (
        segment !== '' &&
        !plain.includes('\\') &&
        !plain.split('/').some((part) => part === '.' || part === '..' || part === '')
      );
    });

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const canonical = (value: unknown): JsonValue =>
  canonicalizePayload({ value: (value ?? null) as JsonValue }).canonical.value ?? null;

/** A generic write, with the project it names when it names one. */
function generic(request: InterceptedRequest, project?: string): Classification {
  const write = requestWrite(request);
  if (write.kind !== 'write' || !project) return write;
  return { ...write, payload: { ...write.payload, resource: project } };
}

// ---------------------------------------------------------------- git

/** What git asks for on a project, after the project's path. */
const GIT_ACTION =
  /^(.+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack|info\/lfs\/objects\/batch|info\/lfs\/locks\/verify)$/;

/**
 * What GitLab does beyond moving the branch for the push options it reads,
 * in plain words: open or merge a merge request, or skip or vary the
 * pipeline. Null when the push names none GitLab acts on.
 */
export function pushOptionWords(options: readonly string[]): string | null {
  const value = (name: string) =>
    options.find((option) => option.startsWith(`${name}=`))?.slice(name.length + 1);
  const has = (name: string) => options.includes(name) || value(name) !== undefined;
  const words: string[] = [];
  if (has('merge_request.create')) {
    const target = value('merge_request.target');
    words.push(`open a merge request${target ? ` into ${target}` : ''}`);
  } else if (has('merge_request.target'))
    words.push(`point its merge request at ${value('merge_request.target')}`);
  const title = value('merge_request.title');
  if (title) words.push(`title it "${title.slice(0, 120)}"`);
  if (has('merge_request.merge_when_pipeline_succeeds') || has('merge_request.auto_merge'))
    words.push('merge it when its pipeline passes, with no further question');
  if (has('merge_request.remove_source_branch')) words.push('delete the branch once merged');
  if (has('merge_request.draft')) words.push('mark it as a draft');
  const variables = options
    .filter((option) => option.startsWith('ci.variable='))
    .map((option) => option.slice('ci.variable='.length).split('=')[0]);
  if (has('ci.skip')) words.push('skip the pipeline');
  if (variables.length) words.push(`run the pipeline with the variables ${variables.join(', ')}`);
  if (has('integrations.skip_ci')) words.push('skip the CI integrations');
  return words.length ? words.join(', ') : null;
}

/** A push whose options make GitLab do more says so in its title and in plain words. */
function withPushOptions(verdict: Classification): Classification {
  if (verdict.kind !== 'write' || verdict.operation !== 'push') return verdict;
  const options = Array.isArray(verdict.payload.push_options)
    ? (verdict.payload.push_options as string[])
    : [];
  const words = pushOptionWords(options);
  if (!words) return verdict;
  return {
    ...verdict,
    summary: {
      title: `${verdict.summary.title}, and ${words}`,
      facts: [{ label: 'GitLab will also', value: words }, ...verdict.summary.facts],
    },
  };
}

function classifyGit(request: InterceptedRequest): Classification {
  if (READS.has(request.method)) return { kind: 'read' };
  const match = canonicalPath(request.path) ? GIT_ACTION.exec(request.path.slice(1)) : null;
  const project = match?.[1] ?? '';
  if (!match || !plainProject(project)) return generic(request);
  const action = match[2];
  if (request.method !== 'POST') return generic(request, project);
  if (action === 'git-upload-pack' && !request.query) return { kind: 'read' };
  if (action === 'git-receive-pack')
    return withPushOptions(classifyPush(request, project, GITLAB_HOST));
  if (action === 'info/lfs/objects/batch' && !request.query)
    return classifyLfsBatch(request, project, GITLAB_HOST);
  // Asks which locks are held; it changes none.
  if (action === 'info/lfs/locks/verify' && !request.query) return { kind: 'read' };
  return generic(request, project);
}

// ---------------------------------------------------------------- GraphQL

/** One sentence for the mutations glab and scripts make most, from the first field. */
function mutationTitle(field: string, input: Record<string, unknown>): string {
  const title = str(input.title, 120);
  const where = str(input.projectPath, 200);
  const inProject = where ? ` in ${where}` : '';
  switch (field) {
    case 'createIssue':
      return `Open an issue${inProject}${title ? `: ${title}` : ''}`;
    case 'mergeRequestCreate':
      return `Open a merge request${inProject}${title ? `: ${title}` : ''}`;
    case 'mergeRequestAccept':
      return `Merge a merge request${inProject}`;
    case 'createNote':
      return 'Comment on GitLab';
    case 'destroyNote':
      return 'Delete a comment on GitLab';
    case 'updateIssue':
      return `Change an issue${inProject}`;
    default:
      return `Change on GitLab: ${field}`;
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
  if (fields.some((field) => MINTING_MUTATION.test(field)))
    return {
      kind: 'refuse',
      reason:
        'Making a token, a runner or a key with this account is refused: it would put a credential in the computer.',
    };
  const [first = 'mutation'] = fields;
  const input = inputOf(sent.variables);
  const variables = canonical(sent.variables);
  const shownVariables =
    sent.variables === null ? '' : `\n\nVariables:\n${JSON.stringify(variables, null, 2)}`;
  return {
    kind: 'write',
    operation: 'graphql',
    payload: {
      site: GITLAB_HOST,
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
        { label: 'Request', value: `${request.method} https://${GITLAB_HOST}${request.path}` },
        { label: 'Changes', value: fields.join(', ') },
        { label: 'Details', value: shownText(`${sent.query.trim()}${shownVariables}`) },
      ],
    },
    destructive: fields.some((field) =>
      /^(?:destroy|delete|remove)|(?:Delete|Destroy)$/.test(field),
    ),
  };
}

// ---------------------------------------------------------------- REST

type RestSummary = { title: string; destructive?: boolean };
type Route = {
  method: string;
  /** Matched against the path after `/api/v4/projects/<id>`. */
  path: RegExp;
  summary: (
    match: RegExpExecArray,
    body: Record<string, unknown>,
    project: string,
    query: URLSearchParams,
  ) => RestSummary;
};

/** A field from the JSON body, or from the query where GitLab reads it too. */
const field = (body: Record<string, unknown>, query: URLSearchParams, name: string) =>
  str(body[name], 200) ?? query.get(name)?.slice(0, 200) ?? undefined;

const STATE_EVENTS: Record<string, string> = { close: 'Close', reopen: 'Reopen' };

const PROJECT_ROUTES: Route[] = [
  {
    method: 'POST',
    path: /^\/merge_requests$/,
    summary: (_m, body, project, query) => {
      const title = field(body, query, 'title');
      const source = field(body, query, 'source_branch');
      const target = field(body, query, 'target_branch');
      return {
        title: `Open a merge request in ${project}${title ? `: ${title}` : ''}${source && target ? ` (${source} → ${target})` : ''}`,
      };
    },
  },
  {
    method: 'PUT',
    path: /^\/merge_requests\/(\d+)\/merge$/,
    summary: (m, body, project, query) => ({
      title: `Merge !${m[1]} in ${project}${
        body.squash === true || query.get('squash') === 'true' ? ', squashed' : ''
      }${
        body.should_remove_source_branch === true ||
        query.get('should_remove_source_branch') === 'true'
          ? ', deleting its source branch'
          : ''
      }`,
    }),
  },
  {
    method: 'POST',
    path: /^\/merge_requests\/(\d+)\/(approve|unapprove)$/,
    summary: (m, _b, project) => ({
      title: `${m[2] === 'approve' ? 'Approve' : 'Withdraw approval of'} !${m[1]} in ${project}`,
    }),
  },
  {
    method: 'POST',
    path: /^\/(merge_requests|issues)\/(\d+)\/notes$/,
    summary: (m, _b, project) => ({
      title: `Comment on ${m[1] === 'issues' ? '#' : '!'}${m[2]} in ${project}`,
    }),
  },
  {
    method: 'PUT',
    path: /^\/(merge_requests|issues)\/(\d+)$/,
    summary: (m, body, project, query) => {
      const event = STATE_EVENTS[field(body, query, 'state_event') ?? ''];
      const ref = `${m[1] === 'issues' ? '#' : '!'}${m[2]}`;
      return { title: `${event ?? 'Change'} ${ref} in ${project}` };
    },
  },
  {
    method: 'DELETE',
    path: /^\/(merge_requests|issues)\/(\d+)$/,
    summary: (m, _b, project) => ({
      title: `Delete ${m[1] === 'issues' ? '#' : '!'}${m[2]} in ${project}`,
      destructive: true,
    }),
  },
  {
    method: 'POST',
    path: /^\/issues$/,
    summary: (_m, body, project, query) => {
      const title = field(body, query, 'title');
      return { title: `Open an issue in ${project}${title ? `: ${title}` : ''}` };
    },
  },
  {
    method: 'POST',
    path: /^\/releases$/,
    summary: (_m, body, project, query) => ({
      title: `Publish release ${field(body, query, 'tag_name') ?? ''} in ${project}`.replace(
        '  ',
        ' ',
      ),
    }),
  },
  {
    method: 'PUT',
    path: /^\/releases\/([^/]+)$/,
    summary: (m, _b, project) => ({ title: `Change release ${decoded(m[1] ?? '')} in ${project}` }),
  },
  {
    method: 'DELETE',
    path: /^\/releases\/([^/]+)$/,
    summary: (m, _b, project) => ({
      title: `Delete release ${decoded(m[1] ?? '')} in ${project}`,
      destructive: true,
    }),
  },
  {
    method: 'POST',
    path: /^\/pipeline$/,
    summary: (_m, body, project, query) => {
      const ref = field(body, query, 'ref');
      return { title: `Run a pipeline${ref ? ` on ${ref}` : ''} in ${project}` };
    },
  },
  {
    method: 'POST',
    path: /^\/(pipelines|jobs)\/(\d+)\/(retry|cancel|play)$/,
    summary: (m, _b, project) => {
      const verb = m[3] === 'retry' ? 'Retry' : m[3] === 'cancel' ? 'Cancel' : 'Run';
      return { title: `${verb} ${m[1] === 'jobs' ? 'job' : 'pipeline'} ${m[2]} in ${project}` };
    },
  },
  {
    method: 'POST',
    path: /^\/variables$/,
    summary: (_m, body, project, query) => ({
      title: `Set the CI/CD variable ${field(body, query, 'key') ?? ''} in ${project}`.replace(
        '  ',
        ' ',
      ),
      destructive: true,
    }),
  },
  {
    method: 'PUT',
    path: /^\/variables\/([^/]+)$/,
    summary: (m, _b, project) => ({
      title: `Set the CI/CD variable ${decoded(m[1] ?? '')} in ${project}`,
      destructive: true,
    }),
  },
  {
    method: 'DELETE',
    path: /^\/variables\/([^/]+)$/,
    summary: (m, _b, project) => ({
      title: `Delete the CI/CD variable ${decoded(m[1] ?? '')} in ${project}`,
      destructive: true,
    }),
  },
  {
    method: 'POST',
    path: /^\/repository\/(branches|tags)$/,
    summary: (m, body, project, query) => {
      const name = field(body, query, m[1] === 'tags' ? 'tag_name' : 'branch');
      const ref = field(body, query, 'ref');
      return {
        title:
          `Create ${m[1] === 'tags' ? 'tag' : 'branch'} ${name ?? ''} in ${project}${ref ? ` at ${ref}` : ''}`.replace(
            '  ',
            ' ',
          ),
      };
    },
  },
  {
    method: 'DELETE',
    path: /^\/repository\/(branches|tags)\/(.+)$/,
    summary: (m, _b, project) => ({
      title: `Delete ${m[1] === 'tags' ? 'tag' : 'branch'} ${decoded(m[2] ?? '')} in ${project}`,
      destructive: true,
    }),
  },
  {
    method: 'POST',
    path: /^\/repository\/commits$/,
    summary: (_m, body, project) => {
      const actions = Array.isArray(body.actions) ? body.actions.length : 0;
      return {
        title: `Commit ${actions} ${actions === 1 ? 'change' : 'changes'} to ${str(body.branch) ?? 'a branch'} in ${project}${body.force === true ? ', overwriting what is there' : ''}`,
        destructive: body.force === true,
      };
    },
  },
  {
    method: 'POST',
    path: /^\/repository\/files\/(.+)$/,
    summary: (m, body, project, query) => ({
      title: `Add ${decoded(m[1] ?? '')} to ${field(body, query, 'branch') ?? 'a branch'} in ${project}`,
    }),
  },
  {
    method: 'PUT',
    path: /^\/repository\/files\/(.+)$/,
    summary: (m, body, project, query) => ({
      title: `Write ${decoded(m[1] ?? '')} on ${field(body, query, 'branch') ?? 'a branch'} in ${project}`,
      destructive: true,
    }),
  },
  {
    method: 'DELETE',
    path: /^\/repository\/files\/(.+)$/,
    summary: (m, body, project, query) => ({
      title: `Delete ${decoded(m[1] ?? '')} on ${field(body, query, 'branch') ?? 'a branch'} in ${project}`,
      destructive: true,
    }),
  },
  {
    method: 'POST',
    path: /^\/protected_branches$/,
    summary: (_m, body, project, query) => ({
      title: `Protect ${field(body, query, 'name') ?? 'a branch'} in ${project}`,
    }),
  },
  {
    method: 'DELETE',
    path: /^\/protected_branches\/(.+)$/,
    summary: (m, _b, project) => ({
      title: `Stop protecting ${decoded(m[1] ?? '')} in ${project}`,
      destructive: true,
    }),
  },
  {
    method: 'POST',
    path: /^\/labels$/,
    summary: (_m, body, project, query) => ({
      title: `Create the label ${field(body, query, 'name') ?? ''} in ${project}`.replace(
        '  ',
        ' ',
      ),
    }),
  },
  {
    method: 'DELETE',
    path: /^$/,
    summary: (_m, _b, project) => ({ title: `Delete the project ${project}`, destructive: true }),
  },
];

const PROJECT_PATH = /^\/api\/v4\/projects\/([^/]+)(\/.*)?$/;

/** The project a REST path names: its path with namespace, or its number. */
function restProject(path: string): { project: string; label: string; rest: string } | null {
  const match = PROJECT_PATH.exec(path);
  if (!match) return null;
  const id = match[1] ?? '';
  const rest = match[2] ?? '';
  if (/^\d{1,20}$/.test(id)) return { project: '', label: `project ${id}`, rest };
  // Only an escaped `/` may appear in a project path; anything else is read no further.
  if (!/^[A-Za-z0-9_.-]+(?:%2[Ff][A-Za-z0-9_.-]+)+$/.test(id)) return null;
  const project = id.replace(/%2[Ff]/g, '/');
  return plainProject(project) ? { project, label: project, rest } : null;
}

function classifyRest(request: InterceptedRequest): Classification {
  if (READS.has(request.method)) return { kind: 'read' };
  if (request.method === 'POST' && API_READ_POSTS.has(request.path) && !request.query)
    return { kind: 'read' };
  const body = canonicalBody(request);
  const parsed = jsonObject(request.body) ?? {};
  const query = new URLSearchParams(request.query);
  const named = canonicalPath(request.path) ? restProject(request.path) : null;
  let summary: RestSummary | null = null;
  if (named) {
    for (const route of PROJECT_ROUTES) {
      if (route.method !== request.method) continue;
      const found = route.path.exec(named.rest);
      if (found) {
        summary = route.summary(found, parsed, named.label, query);
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
      site: GITLAB_HOST,
      method: request.method,
      url_path: request.path,
      query: request.query,
      body,
      ...(named?.project ? { resource: named.project } : {}),
    },
    summary: {
      title: summary?.title ?? `${request.method} ${target}${size}`,
      facts: [
        { label: 'Request', value: `${request.method} https://${GITLAB_HOST}${target}` },
        { label: 'Details', value: shownBody(request, body) },
      ],
    },
    destructive: summary?.destructive ?? (request.method === 'DELETE' || request.method === 'PUT'),
  };
}

// ---------------------------------------------------------------- what is refused

/**
 * API paths whose changes make a credential the computer would then hold: a
 * personal, project, group, impersonation or deploy token, a pipeline trigger
 * token, a runner and its token, a reset of one, and an SSH or deploy key,
 * which would let the computer push without the relay at all.
 */
const MINTS_CREDENTIAL = [
  /^\/api\/v4\/(?:projects|groups|users)\/[^/]+\/(?:access_tokens|personal_access_tokens|impersonation_tokens|deploy_tokens|triggers|runners|deploy_keys|keys)(?:\/|$)/,
  /^\/api\/v4\/user\/(?:personal_access_tokens|runners|keys)(?:\/|$)/,
  /^\/api\/v4\/(?:personal_access_tokens|deploy_tokens|runners|keys)(?:\/|$)/,
  // A cluster agent's tokens, which connect a cluster to the project.
  /^\/api\/v4\/projects\/[^/]+\/cluster_agents(?:\/[^/]+\/tokens)?(?:\/|$)/,
];
/** GraphQL mutations that make a token, a runner or a key. */
export const MINTING_MUTATION = /token|runner(?:Create|Register)|key/i;

/**
 * The path with each segment's escapes undone once, an escaped `/` kept
 * escaped so it stays inside its segment, as GitLab routes it.
 */
const routed = (path: string) =>
  path
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment).replaceAll('/', '%2F');
      } catch {
        return segment;
      }
    })
    .join('/')
    .toLowerCase();

/** Whether a parameter name asks to act as another user: `sudo`, or a form of it such as `sudo[]`. */
const sudoKey = (key: string) => key.toLowerCase().startsWith('sudo');

/**
 * Why a request is never sent with the person's token: one that would act as
 * another user (an administrator's `Sudo`, as a header or a parameter in the
 * query or any kind of body), one that would make a credential for the
 * computer, and glab's usage reports, which are no change the person asked
 * for.
 */
function refusal(request: InterceptedRequest): string | null {
  const type = request.headers['content-type'] ?? '';
  const query = new URLSearchParams(request.query);
  const form = /^application\/x-www-form-urlencoded\b/i.test(type)
    ? new URLSearchParams(request.body.toString('utf8'))
    : null;
  const json = jsonObject(request.body);
  const multipartSudo =
    /^multipart\//i.test(type) && /name\s*=\s*"?sudo/i.test(request.body.toString('latin1'));
  if (
    'sudo' in request.headers ||
    [...query.keys()].some(sudoKey) ||
    [...(form?.keys() ?? [])].some(sudoKey) ||
    Object.keys(json ?? {}).some(sudoKey) ||
    multipartSudo
  )
    return 'Acting as another GitLab user is refused for this account.';
  if (READS.has(request.method)) return null;
  const path = routed(request.path);
  if (path.startsWith('/api/v4/usage_data/'))
    return 'Usage reports from the command line are kept on this computer.';
  if (MINTS_CREDENTIAL.some((route) => route.test(path)) || path.startsWith('/oauth/'))
    return 'Making a token, a runner or a key with this account is refused: it would put a credential in the computer. Make it on GitLab yourself if you need one.';
  return null;
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
    else if (
      (key === 'webUrl' || key === 'url') &&
      typeof item === 'string' &&
      found.urls.length < 20
    )
      found.urls.push(item.slice(0, 2000));
    else graphqlIds(item, found, depth + 1);
  }
}

function receipt(write: ClassifiedWrite, upstream: UpstreamResponse): JsonObject {
  const project = typeof write.payload.resource === 'string' ? write.payload.resource : null;
  if (write.operation === 'push') {
    const report = parseReportStatus(upstream.body);
    return {
      project,
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
  const links = (answer?._links ?? {}) as Record<string, unknown>;
  const link = str(answer?.web_url, 2000) ?? str(links.self, 2000) ?? null;
  return {
    project,
    url: link,
    ...(typeof answer?.iid === 'number' ? { iid: answer.iid } : {}),
  };
}

function rejected(write: ClassifiedWrite, upstream: UpstreamResponse): string | null {
  if (upstream.status >= 400 || write.operation !== 'push') return null;
  const report = parseReportStatus(upstream.body);
  if (!report) return null;
  if (report.unpack !== 'ok')
    return `GitLab did not accept the pushed commits: ${report.unpack.slice(0, 300)}`;
  if (report.refs.length && report.refs.every((ref) => !ref.ok))
    return `GitLab rejected the push: ${report.refs
      .map((ref) => `${refName(ref.ref)}${ref.reason ? ` (${ref.reason.slice(0, 200)})` : ''}`)
      .join(', ')}`;
  return null;
}

/**
 * A GraphQL answer with errors and no data: a mutation's field is nulled when
 * anything under it fails, which can be after the change itself was made, so
 * it cannot say whether the change took effect.
 */
function uncertain(write: ClassifiedWrite, upstream: UpstreamResponse): string | null {
  if (write.operation !== 'graphql' || upstream.status >= 400) return null;
  const answer = jsonObject(upstream.body);
  const errors = Array.isArray(answer?.errors) ? answer.errors : [];
  const data = answer?.data as Record<string, unknown> | null | undefined;
  const landed = data && Object.values(data).some((value) => value !== null);
  if (!errors.length || landed) return null;
  const first = (errors[0] ?? {}) as Record<string, unknown>;
  return `GitLab answered with an error (${str(first.message, 300) ?? 'no message'}), and the change may still have taken effect. Check before asking for it again.`;
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
  // glab and git-lfs print the `message` of a JSON error.
  if (request.path.startsWith('/api/') || write.operation === 'lfs_upload')
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

export const gitlabAdapter: CredentialAdapter<GitlabAdapterConfig> = {
  id: 'gitlab',
  constraints: [GITLAB_HOST],
  parseConfig: (value) => gitlabAdapterConfig.parse(value ?? {}),
  hosts: () => [GITLAB_HOST],
  placeholders: () => ({
    GITLAB_TOKEN: GITLAB_TOKEN_PLACEHOLDER,
    GIT_TERMINAL_PROMPT: '0',
  }),
  standIns: () => [GITLAB_TOKEN_PLACEHOLDER],
  classify(request) {
    if (request.host !== GITLAB_HOST)
      return {
        kind: 'refuse',
        reason: `${request.host} is not a GitLab host this account covers.`,
      };
    const refused = refusal(request);
    if (refused) return { kind: 'refuse', reason: refused };
    if (request.path === '/api/graphql') return classifyGraphql(request);
    if (request.path.startsWith('/api/')) return classifyRest(request);
    return classifyGit(request);
  },
  authorize(request: OutboundRequest, secret: string): OutboundRequest {
    const headers = { ...request.headers };
    // The token is added once, in the one place each part of GitLab reads it.
    delete headers['private-token'];
    delete headers['job-token'];
    if (request.target.startsWith('/api/')) headers['private-token'] = secret;
    else headers.authorization = `Basic ${Buffer.from(`oauth2:${secret}`).toString('base64')}`;
    return { ...request, headers };
  },
  redactions: (secret) => [
    secret,
    Buffer.from(`oauth2:${secret}`).toString('base64'),
    Buffer.from(secret).toString('base64'),
  ],
  receipt,
  rejected,
  uncertain,
  heldAnswer,
  mintedCredentials: [
    'gitlab_personal',
    'gitlab_deploy',
    'gitlab_runner',
    'gitlab_trigger',
    'gitlab_agent',
    'gitlab_feed',
    'gitlab_incoming_mail',
  ],
};

/** What GitLab says about a token: the account it belongs to, or why it was refused. */
export type GitlabAccountCheck =
  | { ok: true; login: string }
  | { ok: false; code: 'credential_refused' | 'unavailable' };

/**
 * Asks GitLab whose token this is (`GET /api/v4/user`), from the service. The
 * token goes only to gitlab.com, or to the address a test names.
 */
export async function gitlabAccount(
  token: string,
  options: { fetch?: typeof fetch; api?: string; signal?: AbortSignal } = {},
): Promise<GitlabAccountCheck> {
  const call = options.fetch ?? fetch;
  try {
    const response = await call(`${options.api ?? `https://${GITLAB_HOST}`}/api/v4/user`, {
      headers: { 'private-token': token, accept: 'application/json', 'user-agent': 'Melete' },
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
    return typeof user.username === 'string' && /^[A-Za-z0-9_.-]{1,255}$/.test(user.username)
      ? { ok: true, login: user.username }
      : { ok: false, code: 'unavailable' };
  } catch {
    return { ok: false, code: 'unavailable' };
  }
}
