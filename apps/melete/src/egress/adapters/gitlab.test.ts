import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { canonicalizePayload } from '@melete/contracts';
import { egressPayload } from '../../broker/egress-admission.ts';
import { parseReportStatus } from '../git-pktline.ts';
import { requestBinding, upstreamHeaders } from '../intercept.ts';
import { recordedCorpus, recordedFile } from './corpus.ts';
import { GITLAB_TOKEN_PLACEHOLDER, gitlabAccount, gitlabAdapter } from './gitlab.ts';
import type { ClassifiedWrite, InterceptedRequest } from './types.ts';

const FIXTURES = path.join(import.meta.dir, 'fixtures', 'gitlab');
const config = gitlabAdapter.parseConfig({});
const corpus = recordedCorpus(FIXTURES, [GITLAB_TOKEN_PLACEHOLDER]);
const one = (file: string, index: number) => {
  const found = recordedFile(FIXTURES, file, [GITLAB_TOKEN_PLACEHOLDER])[index];
  if (!found) throw new Error(`no request ${index} in ${file}`);
  return found.request;
};
const write = (request: InterceptedRequest): ClassifiedWrite => {
  const verdict = gitlabAdapter.classify(request, config);
  if (verdict.kind !== 'write') throw new Error(`expected a write, got ${verdict.kind}`);
  return verdict;
};
/** The hash a write's approval is bound to, as the relay computes it. */
const approvalHash = (request: InterceptedRequest) => {
  const verdict = write(request);
  return canonicalizePayload(
    egressPayload({
      ...verdict,
      payload: {
        ...verdict.payload,
        request: requestBinding(request.headers, request.body, verdict.boundBody),
      },
    }),
  ).hash;
};
const api = (
  method: string,
  target: string,
  body = '',
  headers: Record<string, string> = {},
): InterceptedRequest => {
  const [pathPart = '', query = ''] = target.split('?');
  return {
    host: 'gitlab.com',
    method,
    path: pathPart,
    query,
    headers: { 'content-type': 'application/json', ...headers },
    body: Buffer.from(body),
  };
};

describe('the GitLab classifier on recorded glab and git requests', () => {
  test('every change in the glab and git corpus is classified as a write', () => {
    const writes = corpus.filter((entry) => entry.label === 'write');
    // The recorded corpus covers each glab command that changes something, and git's pushes.
    expect(writes.length).toBeGreaterThanOrEqual(40);
    expect(corpus.filter((entry) => entry.label === 'read').length).toBeGreaterThanOrEqual(40);
    for (const entry of corpus) {
      const verdict = gitlabAdapter.classify(entry.request, config);
      const target = `${entry.request.method} ${entry.request.host}${entry.request.path}`;
      expect({ file: entry.file, target, kind: verdict.kind }).toEqual({
        file: entry.file,
        target,
        kind: entry.label,
      });
    }
  });

  test('a push is asked for with its project, each exact ref update and its push options', () => {
    const created = write(one('git-push-new-branch.http', 1));
    expect(created.operation).toBe('push');
    expect(created.destructive).toBe(false);
    expect(created.payload).toMatchObject({
      site: 'gitlab.com',
      resource: 'alice/site',
      updates: [{ ref: 'refs/heads/melete/fix-login', old: '0'.repeat(40) }],
      push_options: [],
    });
    expect(created.summary.title).toBe('Push to alice/site (melete/fix-login)');
    const options = write(one('git-push-options.http', 1));
    expect(options.payload.push_options).toEqual([
      'merge_request.create',
      'merge_request.target=main',
      'ci.skip',
    ]);
    expect(options.summary.facts).toContainEqual({
      label: 'Push options',
      value: 'merge_request.create\nmerge_request.target=main\nci.skip',
    });
    // A project in a subgroup is named by its whole path.
    const nested = write(one('git-subgroup-push.http', 1));
    expect(nested.payload.resource).toBe('acme/team/site');
    expect(nested.summary.title).toBe('Push to acme/team/site (melete/docs)');
    const atomic = write(one('git-push-atomic-two.http', 1));
    expect((atomic.payload.updates as Array<{ ref: string }>).map((u) => u.ref)).toEqual([
      'refs/heads/main',
      'refs/tags/v1.0.0',
    ]);
  });

  test('a branch delete is shown as a delete', () => {
    const deleted = write(one('git-push-delete.http', 1));
    expect(deleted.destructive).toBe(true);
    expect(deleted.summary.title).toBe('Delete melete/fix-login in alice/site');
  });

  test('a push run again with other pack bytes is the same approval, and a different commit is a new one', () => {
    const request = one('git-push-new-branch.http', 1);
    const pack = request.body.indexOf('PACK');
    expect(pack).toBeGreaterThan(0);
    const repacked = {
      ...request,
      body: Buffer.concat([request.body.subarray(0, pack), Buffer.from('PACK-other-bytes')]),
    };
    expect(approvalHash(repacked)).toBe(approvalHash(request));
    const text = request.body.toString('latin1');
    const id = /0{40} ([0-9a-f]{40})/.exec(text)?.[1] ?? '';
    const other = {
      ...request,
      body: Buffer.from(text.replace(id, 'f'.repeat(40)), 'latin1'),
    };
    expect(approvalHash(other)).not.toBe(approvalHash(request));
  });

  test('merge requests, issues, releases and pipelines are summarised by what they do', () => {
    const titles = (file: string) =>
      recordedFile(FIXTURES, file, [GITLAB_TOKEN_PLACEHOLDER])
        .filter((entry) => entry.label === 'write')
        .map((entry) => write(entry.request).summary.title);
    expect(titles('glab-mr-create.http')).toEqual([
      'Open a merge request in alice/site: Fix (melete/fix-login → main)',
    ]);
    expect(titles('glab-mr-merge.http')).toEqual(['Merge !7 in alice/site']);
    expect(titles('glab-mr-approve.http')).toEqual(['Approve !7 in alice/site']);
    expect(titles('glab-mr-note.http')).toEqual(['Comment on !7 in alice/site']);
    expect(titles('glab-mr-close.http')).toEqual(['Close !7 in alice/site']);
    expect(titles('glab-issue-create.http')).toEqual(['Open an issue in alice/site: Hello']);
    expect(titles('glab-issue-delete.http')).toEqual(['Delete #3 in alice/site']);
    expect(titles('glab-release-create.http')).toEqual(['Change release v1.0.0 in alice/site']);
    expect(titles('glab-ci-run.http')).toEqual(['Run a pipeline on main in alice/site']);
    // A project named by its number is named that way, and no repository is claimed for it.
    expect(titles('glab-ci-cancel.http')).toEqual(['Cancel pipeline 5 in project 42']);
    expect(write(one('glab-ci-cancel.http', 1)).payload.resource).toBeUndefined();
    expect(titles('glab-variable-delete.http')).toEqual([
      'Delete the CI/CD variable K in alice/site',
    ]);
    expect(titles('glab-repo-delete.http')).toEqual(['Delete the project alice/site']);
    expect(write(one('glab-repo-delete.http', 0)).destructive).toBe(true);
    // Written inline, the input is shown under Details rather than in the title.
    expect(titles('glab-api-graphql-mutation.http')).toEqual(['Open an issue']);
    const forced = write(
      api(
        'POST',
        '/api/v4/projects/alice%2Fsite/repository/commits',
        JSON.stringify({ branch: 'main', actions: [{}, {}], force: true }),
      ),
    );
    expect(forced.summary.title).toBe(
      'Commit 2 changes to main in alice/site, overwriting what is there',
    );
    expect(forced.destructive).toBe(true);
  });

  test('a path that could name two projects claims none', () => {
    for (const target of [
      '/api/v4/projects/alice%2E%2E%2Fsite/issues',
      '/api/v4/projects/alice%2F..%2Fbob/issues',
      '/api/v4/projects/alice%2Fsite/../bob%2Fx/issues',
      '/api/v4/projects/alice%252Fsite/issues',
    ]) {
      const verdict = write(api('POST', target, '{"title":"x"}'));
      expect({ target, resource: verdict.payload.resource }).toEqual({
        target,
        resource: undefined,
      });
      expect(verdict.summary.title).toStartWith('POST ');
    }
  });

  test('a request acting as another user, and glab usage reports, are refused', () => {
    const refusals = [
      api('GET', '/api/v4/user', '', { sudo: 'root' }),
      api('GET', '/api/v4/projects?Sudo=bob'),
      api('POST', '/api/v4/projects/alice%2Fsite/issues', '{"title":"x","sudo":"bob"}'),
      api('POST', '/api/v4/usage_data/track_event', '{"event":"gitlab_cli_command_used"}'),
      { ...api('GET', '/api/v4/user'), host: 'evil.gitlab.com' },
    ];
    for (const request of refusals)
      expect(gitlabAdapter.classify(request, config).kind).toBe('refuse');
    expect(gitlabAdapter.classify(api('GET', '/api/v4/usage_data/x'), config).kind).toBe('read');
  });

  test('the token goes as oauth2 Basic for git and as PRIVATE-TOKEN for the API, and the placeholder never travels', () => {
    const secret = 'glpat-secret-value';
    const headers = upstreamHeaders(
      { 'private-token': GITLAB_TOKEN_PLACEHOLDER, 'job-token': 'other', accept: 'x' },
      [GITLAB_TOKEN_PLACEHOLDER],
    );
    expect(headers['private-token']).toBeUndefined();
    const toApi = gitlabAdapter.authorize(
      { host: 'gitlab.com', method: 'GET', target: '/api/v4/user', headers, body: Buffer.alloc(0) },
      secret,
      config,
    );
    expect(toApi.headers['private-token']).toBe(secret);
    expect(toApi.headers['job-token']).toBeUndefined();
    expect(toApi.headers.authorization).toBeUndefined();
    const toGit = gitlabAdapter.authorize(
      {
        host: 'gitlab.com',
        method: 'GET',
        target: '/alice/site.git/info/refs?service=git-upload-pack',
        headers: {},
        body: Buffer.alloc(0),
      },
      secret,
      config,
    );
    expect(toGit.headers.authorization).toBe(
      `Basic ${Buffer.from(`oauth2:${secret}`).toString('base64')}`,
    );
    expect(toGit.headers['private-token']).toBeUndefined();
    expect(gitlabAdapter.redactions(secret)).toContain(
      Buffer.from(`oauth2:${secret}`).toString('base64'),
    );
    expect(gitlabAdapter.placeholders(config)).toEqual({
      GITLAB_TOKEN: GITLAB_TOKEN_PLACEHOLDER,
      GIT_TERMINAL_PROMPT: '0',
    });
  });

  test('a push GitLab rejects is recorded as failed, and an errors-only GraphQL answer as possibly landed', () => {
    const push = write(one('git-push-new-branch.http', 1));
    const pkt = (text: string) => `${(text.length + 4).toString(16).padStart(4, '0')}${text}`;
    const report = (lines: string[]) =>
      Buffer.from(`${pkt(`\x01${pkt('unpack ok\n')}${lines.map(pkt).join('')}0000`)}0000`);
    const refused = report(['ng refs/heads/melete/fix-login protected branch hook declined\n']);
    expect(parseReportStatus(refused)?.refs[0]?.ok).toBe(false);
    expect(gitlabAdapter.rejected?.(push, { status: 200, headers: {}, body: refused })).toBe(
      'GitLab rejected the push: melete/fix-login (protected branch hook declined)',
    );
    const accepted = report(['ok refs/heads/melete/fix-login\n']);
    expect(gitlabAdapter.rejected?.(push, { status: 200, headers: {}, body: accepted })).toBeNull();
    expect(gitlabAdapter.receipt(push, { status: 200, headers: {}, body: accepted })).toEqual({
      project: 'alice/site',
      unpack: 'ok',
      refs: [{ ref: 'refs/heads/melete/fix-login', ok: true }],
    });
    const mutation = write(one('glab-api-graphql-mutation.http', 0));
    const answer = (body: unknown) => ({
      status: 200,
      headers: {},
      body: Buffer.from(JSON.stringify(body)),
    });
    expect(
      gitlabAdapter.uncertain?.(
        mutation,
        answer({ data: { createIssue: null }, errors: [{ message: 'x' }] }),
      ),
    ).toContain('may still have taken effect');
    expect(
      gitlabAdapter.uncertain?.(
        mutation,
        answer({ data: { createIssue: { issue: { id: 'gid://gitlab/Issue/1' } } } }),
      ),
    ).toBeNull();
  });

  test('the receipt links what a REST change made', () => {
    const created = write(one('glab-mr-create.http', 1));
    const receipt = gitlabAdapter.receipt(created, {
      status: 201,
      headers: {},
      body: Buffer.from(
        JSON.stringify({ iid: 7, web_url: 'https://gitlab.com/alice/site/-/merge_requests/7' }),
      ),
    });
    expect(receipt).toEqual({
      project: 'alice/site',
      url: 'https://gitlab.com/alice/site/-/merge_requests/7',
      iid: 7,
    });
  });

  test('a held change is answered the way git and glab print an answer', () => {
    const message = 'Waiting for your approval in Melete: Push to alice/site (melete/fix-login).';
    const request = one('git-push-new-branch.http', 1);
    const held = gitlabAdapter.heldAnswer?.(request, write(request), message, 403);
    expect(held?.status).toBe(200);
    expect(held?.headers['content-type']).toBe('application/x-git-receive-pack-result');
    expect(held?.body.toString('latin1')).toContain(`ng refs/heads/melete/fix-login ${message}`);
    const rest = one('glab-issue-create.http', 1);
    const answered = gitlabAdapter.heldAnswer?.(rest, write(rest), message, 403);
    expect(answered?.status).toBe(403);
    expect(JSON.parse(answered?.body.toString() ?? '{}')).toEqual({ message });
  });
});

describe('asking GitLab whose token it is', () => {
  test('the account is read from the user GitLab answers, and a refused token says so', async () => {
    const seen: Array<{ url: string; token: string | null }> = [];
    const answer = (status: number, body: unknown) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({
          url: String(url),
          token: new Headers(init?.headers).get('private-token'),
        });
        return new Response(JSON.stringify(body), { status });
      }) as typeof fetch;
    expect(
      await gitlabAccount('glpat-x', {
        fetch: answer(200, { username: 'alice' }),
        api: 'https://gl.test',
      }),
    ).toEqual({ ok: true, login: 'alice' });
    expect(seen).toEqual([{ url: 'https://gl.test/api/v4/user', token: 'glpat-x' }]);
    expect(await gitlabAccount('glpat-x', { fetch: answer(401, {}) })).toEqual({
      ok: false,
      code: 'credential_refused',
    });
    expect(seen.at(-1)?.url).toBe('https://gitlab.com/api/v4/user');
    expect(await gitlabAccount('glpat-x', { fetch: answer(503, {}) })).toEqual({
      ok: false,
      code: 'unavailable',
    });
  });
});
