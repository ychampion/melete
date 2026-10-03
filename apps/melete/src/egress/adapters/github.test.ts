import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalizePayload } from '@melete/contracts';
import { egressPayload } from '../../broker/egress-admission.ts';
import { parseReportStatus } from '../git-pktline.ts';
import { requestBinding, upstreamHeaders } from '../intercept.ts';
import { GITHUB_TOKEN_PLACEHOLDER, githubAccount, githubAdapter } from './github.ts';
import type { ClassifiedWrite, InterceptedRequest } from './types.ts';

const FIXTURES = path.join(import.meta.dir, 'fixtures', 'github');
const config = githubAdapter.parseConfig({});

type Recorded = { file: string; label: 'read' | 'write' | 'refuse'; request: InterceptedRequest };

/** The requests in one `.http` file, each with the class its label says it is. */
function recorded(file: string): Recorded[] {
  const text = readFileSync(path.join(FIXTURES, file), 'utf8').replace(/\r\n/g, '\n');
  return text
    .split(/^### /m)
    .slice(1)
    .map((block) => {
      const [labelLine = '', requestLine = '', ...rest] = block.split('\n');
      const [label, encoding] = labelLine.trim().split(' ');
      const [method = '', address = ''] = requestLine.split(' ');
      const blank = rest.indexOf('');
      const headerLines = rest.slice(0, blank < 0 ? rest.length : blank);
      const bodyText = (blank < 0 ? [] : rest.slice(blank + 1)).join('\n').replace(/\n+$/, '');
      const raw: Record<string, string> = {};
      for (const line of headerLines) {
        const colon = line.indexOf(':');
        raw[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }
      const url = new URL(address);
      return {
        file,
        label: label as Recorded['label'],
        request: {
          host: url.hostname,
          method,
          path: url.pathname,
          query: url.search.slice(1),
          headers: upstreamHeaders(raw, [GITHUB_TOKEN_PLACEHOLDER]),
          body:
            encoding === 'base64'
              ? Buffer.from(bodyText.replace(/\s+/g, ''), 'base64')
              : Buffer.from(bodyText),
        },
      };
    });
}

const corpus = readdirSync(FIXTURES)
  .filter((file) => file.endsWith('.http'))
  .sort()
  .flatMap(recorded);
const one = (file: string, index: number) => {
  const found = recorded(file)[index];
  if (!found) throw new Error(`no request ${index} in ${file}`);
  return found.request;
};
const write = (request: InterceptedRequest): ClassifiedWrite => {
  const verdict = githubAdapter.classify(request, config);
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

describe('the GitHub classifier on recorded gh and git requests', () => {
  test('every mutation in the gh corpus is classified as a write', () => {
    const writes = corpus.filter((entry) => entry.label === 'write');
    // The recorded corpus covers each gh command that changes something, and git's pushes.
    expect(writes.length).toBeGreaterThanOrEqual(40);
    for (const entry of corpus) {
      const verdict = githubAdapter.classify(entry.request, config);
      expect({
        file: entry.file,
        target: `${entry.request.method} ${entry.request.host}${entry.request.path}`,
        kind: verdict.kind,
      }).toEqual({
        file: entry.file,
        target: `${entry.request.method} ${entry.request.host}${entry.request.path}`,
        kind: entry.label,
      });
    }
  });

  test('a push is asked for with its repository and each exact ref update', () => {
    const created = write(one('git-push-new-branch.http', 1));
    expect(created.operation).toBe('push');
    expect(created.destructive).toBe(false);
    expect(created.payload).toMatchObject({
      site: 'github.com',
      resource: 'alice/site',
      updates: [
        {
          ref: 'refs/heads/melete/fix-login',
          old: '0000000000000000000000000000000000000000',
          new: '73cd911b5626ddbf8abd727ac93642f1825cc3e2',
        },
      ],
    });
    expect(created.summary.title).toBe('Push to alice/site (melete/fix-login)');
    expect(created.summary.facts).toContainEqual({
      label: 'melete/fix-login',
      value: 'new branch at 73cd911',
    });
    const updated = write(one('git-push-update.http', 1));
    expect(updated.summary.facts).toContainEqual({
      label: 'melete/fix-login',
      value: 'update 73cd911 → a657050',
    });
    const options = write(one('git-push-options.http', 1));
    expect(options.payload.push_options).toEqual(['ci.skip', 'merge_request.create']);
    const atomic = write(one('git-push-atomic-two.http', 1));
    expect((atomic.payload.updates as Array<{ ref: string }>).map((u) => u.ref)).toEqual([
      'refs/heads/main',
      'refs/tags/v1.0.0',
    ]);
    expect(atomic.summary.facts.map((fact) => fact.label)).toContain('All or nothing');
  });

  test('a branch delete is shown as a delete', () => {
    const deleted = write(one('git-push-delete.http', 1));
    expect(deleted.destructive).toBe(true);
    expect(deleted.summary.title).toBe('Delete melete/fix-login in alice/site');
    expect(deleted.summary.facts).toContainEqual({
      label: 'melete/fix-login',
      value: 'delete (was 42e9cb1)',
    });
    const viaApi = write(one('gh-pr-merge.http', 2));
    expect(viaApi.destructive).toBe(true);
    expect(viaApi.summary.title).toBe('Delete melete/fix-login in alice/site');
  });

  test('a push with a different new commit is a new approval, and the same push with another pack is not', () => {
    const push = one('git-push-update.http', 1);
    const base = approvalHash(push);
    // Same commands, different pack bytes: the commits are named by hash.
    const repacked = Buffer.from(push.body);
    repacked[repacked.length - 1] = (repacked.at(-1) ?? 0) ^ 0xff;
    expect(approvalHash({ ...push, body: repacked })).toBe(base);
    // Another new commit.
    const text = push.body.toString('latin1').replace('a657050d', 'a657050e');
    expect(approvalHash({ ...push, body: Buffer.from(text, 'latin1') })).not.toBe(base);
    // Another repository.
    expect(approvalHash({ ...push, path: '/alice/other.git/git-receive-pack' })).not.toBe(base);
    // A header that changes what the server does.
    expect(approvalHash({ ...push, headers: { ...push.headers, 'x-extra': 'yes' } })).not.toBe(
      base,
    );
  });

  test('a push whose commands cannot be read exactly, or whose path is not plain, asks as the request itself', () => {
    const push = one('git-push-update.http', 1);
    const broken = Buffer.from(push.body);
    broken.write('zz', 0, 'latin1');
    const unreadable = write({ ...push, body: broken });
    expect(unreadable.operation).toBe('request');
    expect(unreadable.boundBody).toBeUndefined();
    const dotted = write({ ...push, path: '/alice/site/../mallory/site.git/git-receive-pack' });
    expect(dotted.operation).toBe('request');
    expect(dotted.payload.resource).toBeUndefined();
    const encoded = write({ ...push, path: '/alice/%2e%2e/mallory/site.git/git-receive-pack' });
    expect(encoded.payload.resource).toBeUndefined();
  });

  test('gh pr create is summarised with its title and branches, and its body shown in full', () => {
    const created = write(one('gh-pr-create.http', 2));
    expect(created.operation).toBe('graphql');
    expect(created.summary.title).toBe('Open a pull request: Fix (melete/fix-login → main)');
    expect(created.payload.graphql).toMatchObject({
      operation_name: 'PullRequestCreate',
      fields: ['createPullRequest'],
    });
    const details = created.summary.facts.find((fact) => fact.label === 'Details')?.value ?? '';
    expect(details).toContain('mutation PullRequestCreate');
    expect(details).toContain('"headRefName": "melete/fix-login"');
  });

  test('an LFS batch that names its operation twice asks, whichever one a parser keeps', () => {
    const upload = one('edge-hand-written.http', 4);
    const twice = Buffer.from(
      upload.body
        .toString()
        .replace('"operation":"upload"', '"operation":"upload","operation":"download"'),
    );
    expect(githubAdapter.classify({ ...upload, body: twice }, config).kind).toBe('write');
    const download = one('edge-hand-written.http', 5);
    expect(githubAdapter.classify(download, config).kind).toBe('read');
  });

  test('common REST writes have summaries, and others say what they send', () => {
    expect(write(one('gh-release-create.http', 0)).summary.title).toBe(
      'Publish release v1.0.0 in alice/site',
    );
    expect(write(one('gh-workflow-run.http', 1)).summary.title).toBe(
      'Run workflow 42 on main in alice/site',
    );
    expect(write(one('gh-run-rerun.http', 2)).summary.title).toBe(
      'Re-run workflow run 123 in alice/site',
    );
    const repoDelete = write(one('gh-repo-delete.http', 0));
    expect(repoDelete).toMatchObject({
      destructive: true,
      summary: { title: 'Delete the repository alice/site' },
    });
    const hook = write(one('edge-hand-written.http', 22));
    expect(hook.summary.title).toMatch(/^POST \/repos\/alice\/site\/hooks, \d+ bytes JSON$/);
    expect(hook.payload.resource).toBe('alice/site');
    const forced = write(one('edge-hand-written.http', 24));
    expect(forced.destructive).toBe(true);
  });
});

describe('what GitHub answers become', () => {
  const reportOf = (lines: string[], sideband: boolean) => {
    const pkt = (text: string) => `${(text.length + 4).toString(16).padStart(4, '0')}${text}`;
    const inner = `${lines.map(pkt).join('')}0000`;
    return Buffer.from(sideband ? `${pkt(`\x01${inner}`)}0000` : inner, 'latin1');
  };

  test('a push receipt lists each ref as the server reported it', () => {
    const push = write(one('git-push-update.http', 1));
    const body = reportOf(['unpack ok\n', 'ok refs/heads/melete/fix-login\n'], true);
    const answer = { status: 200, headers: {}, body };
    expect(githubAdapter.receipt(push, answer)).toEqual({
      repository: 'alice/site',
      unpack: 'ok',
      refs: [{ ref: 'refs/heads/melete/fix-login', ok: true }],
    });
    expect(githubAdapter.rejected?.(push, answer)).toBeNull();
    const refused = reportOf(
      ['unpack ok\n', 'ng refs/heads/melete/fix-login protected branch\n'],
      false,
    );
    expect(githubAdapter.rejected?.(push, { status: 200, headers: {}, body: refused })).toBe(
      'GitHub rejected the push: melete/fix-login (protected branch)',
    );
    expect(parseReportStatus(refused)?.refs).toEqual([
      { ref: 'refs/heads/melete/fix-login', ok: false, reason: 'protected branch' },
    ]);
  });

  test('a pull request receipt links it, and a GraphQL answer of only errors may still have landed', () => {
    const created = write(one('gh-pr-create.http', 2));
    const body = Buffer.from(
      JSON.stringify({
        data: {
          createPullRequest: {
            pullRequest: { id: 'PR_kwDOA7', url: 'https://github.com/alice/site/pull/7' },
          },
        },
      }),
    );
    expect(githubAdapter.receipt(created, { status: 200, headers: {}, body })).toEqual({
      node_ids: ['PR_kwDOA7'],
      urls: ['https://github.com/alice/site/pull/7'],
    });
    const failed = Buffer.from(
      JSON.stringify({ data: { createPullRequest: null }, errors: [{ message: 'No commits' }] }),
    );
    // GraphQL nulls a mutation's field when anything under it fails, possibly after the change.
    expect(
      githubAdapter.rejected?.(created, { status: 200, headers: {}, body: failed }),
    ).toBeNull();
    expect(
      githubAdapter.uncertain?.(created, { status: 200, headers: {}, body: failed }),
    ).toStartWith(
      'GitHub answered with an error (No commits), and the change may still have taken effect.',
    );
    const landed = Buffer.from(
      JSON.stringify({
        data: { createPullRequest: { pullRequest: { id: 'PR_1' } } },
        errors: [{ message: 'a later field failed' }],
      }),
    );
    expect(
      githubAdapter.uncertain?.(created, { status: 200, headers: {}, body: landed }),
    ).toBeNull();
    const issue = write(one('gh-release-create.http', 0));
    expect(
      githubAdapter.receipt(issue, {
        status: 201,
        headers: {},
        body: Buffer.from('{"html_url":"https://github.com/alice/site/releases/tag/v1.0.0"}'),
      }),
    ).toMatchObject({ url: 'https://github.com/alice/site/releases/tag/v1.0.0' });
  });

  test('a held push is answered in git’s own words, and a held API call as a JSON message', () => {
    const request = one('git-push-new-branch.http', 1);
    const held = githubAdapter.heldAnswer?.(
      request,
      write(request),
      'Waiting for your approval.',
      403,
    );
    expect(held?.status).toBe(200);
    expect(held?.headers['content-type']).toBe('application/x-git-receive-pack-result');
    expect(parseReportStatus(held?.body ?? Buffer.alloc(0))).toEqual({
      unpack: 'ok',
      refs: [
        { ref: 'refs/heads/melete/fix-login', ok: false, reason: 'Waiting for your approval.' },
      ],
    });
    const api = one('gh-release-create.http', 0);
    const json = githubAdapter.heldAnswer?.(api, write(api), 'Waiting for your approval.', 403);
    expect(json?.status).toBe(403);
    expect(JSON.parse(json?.body.toString() ?? '{}')).toEqual({
      message: 'Waiting for your approval.',
    });
  });
});

describe('the account on the wire', () => {
  test('git gets the token as a basic credential and the API as a bearer token, and both are redacted', async () => {
    const token = 'github_pat_11ABCDEFG0123456789';
    const git = await githubAdapter.authorize(
      {
        host: 'github.com',
        method: 'GET',
        target: '/alice/site.git/info/refs',
        headers: {},
        body: Buffer.alloc(0),
      },
      token,
      config,
      { command: null },
    );
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    expect(git.headers.authorization).toBe(`Basic ${basic}`);
    const api = await githubAdapter.authorize(
      {
        host: 'api.github.com',
        method: 'GET',
        target: '/user',
        headers: {},
        body: Buffer.alloc(0),
      },
      token,
      config,
      { command: null },
    );
    expect(api.headers.authorization).toBe(`Bearer ${token}`);
    expect(githubAdapter.redactions(token)).toEqual(expect.arrayContaining([token, basic]));
  });

  test('the computer gets placeholders only, and only the token placeholder is stripped from headers', () => {
    expect(githubAdapter.placeholders(config)).toEqual({
      GH_TOKEN: GITHUB_TOKEN_PLACEHOLDER,
      GH_PROMPT_DISABLED: '1',
      GIT_TERMINAL_PROMPT: '0',
    });
    const kept = upstreamHeaders(
      { 'x-github-api-version': '2022-11-28', 'x-carried': `token ${GITHUB_TOKEN_PLACEHOLDER}` },
      githubAdapter.standIns?.(config) ?? [],
    );
    expect(kept).toEqual({ 'x-github-api-version': '2022-11-28' });
  });

  test('connecting asks GitHub whose token it is, and a refused token says so', async () => {
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const answer = (status: number, body: unknown) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({
          url: String(url),
          authorization: new Headers(init?.headers).get('authorization'),
        });
        return new Response(JSON.stringify(body), { status });
      }) as typeof fetch;
    expect(await githubAccount('tok', { fetch: answer(200, { login: 'alice' }) })).toEqual({
      ok: true,
      login: 'alice',
    });
    expect(seen[0]).toEqual({ url: 'https://api.github.com/user', authorization: 'Bearer tok' });
    expect(
      await githubAccount('tok', { fetch: answer(401, { message: 'Bad credentials' }) }),
    ).toEqual({ ok: false, code: 'credential_refused' });
  });
});
