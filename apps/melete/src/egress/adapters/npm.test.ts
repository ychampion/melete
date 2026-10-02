import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { canonicalizePayload } from '@melete/contracts';
import { egressPayload } from '../../broker/egress-admission.ts';
import { requestBinding, upstreamHeaders } from '../intercept.ts';
import { recordedCorpus, recordedFile } from './corpus.ts';
import { NPM_TOKEN_ENV, NPM_TOKEN_PLACEHOLDER, npmAccount, npmAdapter } from './npm.ts';
import type { ClassifiedWrite, InterceptedRequest } from './types.ts';

const FIXTURES = path.join(import.meta.dir, 'fixtures', 'npm');
const config = npmAdapter.parseConfig({});
const corpus = recordedCorpus(FIXTURES, [NPM_TOKEN_PLACEHOLDER]);
const one = (file: string, index: number) => {
  const found = recordedFile(FIXTURES, file, [NPM_TOKEN_PLACEHOLDER])[index];
  if (!found) throw new Error(`no request ${index} in ${file}`);
  return found.request;
};
const writes = (file: string) =>
  recordedFile(FIXTURES, file, [NPM_TOKEN_PLACEHOLDER])
    .filter((entry) => entry.label === 'write')
    .map((entry) => write(entry.request));
const write = (request: InterceptedRequest): ClassifiedWrite => {
  const verdict = npmAdapter.classify(request, config);
  if (verdict.kind !== 'write') throw new Error(`expected a write, got ${verdict.kind}`);
  return verdict;
};
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
const put = (target: string, body: unknown): InterceptedRequest => ({
  host: 'registry.npmjs.org',
  method: 'PUT',
  path: target,
  query: '',
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(body)),
});

describe('the npm classifier on recorded npm requests', () => {
  test('every change in the npm corpus is classified as a write, and installs and audits read', () => {
    expect(corpus.filter((entry) => entry.label === 'write').length).toBeGreaterThanOrEqual(30);
    for (const entry of corpus) {
      const verdict = npmAdapter.classify(entry.request, config);
      const target = `${entry.request.method} ${entry.request.host}${entry.request.path}`;
      expect({ file: entry.file, target, kind: verdict.kind }).toEqual({
        file: entry.file,
        target,
        kind: entry.label,
      });
    }
    // The install and its audit lookup go through without asking.
    expect(
      recordedFile(FIXTURES, 'npm-install.http', [NPM_TOKEN_PLACEHOLDER]).map(
        (entry) => npmAdapter.classify(entry.request, config).kind,
      ),
    ).toEqual(['read', 'read', 'read', 'read']);
  });

  test('a publish names the package, its version, tag and tarball, and binds the tarball bytes', () => {
    const request = one('npm-publish.http', 2);
    const published = write(request);
    expect(published.operation).toBe('publish');
    expect(published.destructive).toBe(false);
    expect(published.summary.title).toBe('Publish melete-demo@1.0.0 to npm (tag latest)');
    expect(published.payload).toMatchObject({
      site: 'registry.npmjs.org',
      resource: 'melete-demo',
      publish: { versions: ['1.0.0'], dist_tags: { latest: '1.0.0' }, access: null },
    });
    const [tarball] = (published.payload.publish as { tarballs: Array<{ file: string }> }).tarballs;
    expect(tarball?.file).toBe('melete-demo-1.0.0.tgz');
    // The tarball travels base64 inside the JSON; the payload keeps its digest, not its bytes.
    expect(JSON.stringify(published.payload).length).toBeLessThan(request.body.length + 2000);
    expect(published.payload.body).toEqual({
      bytes: request.body.length,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // Any other tarball byte is a new approval.
    const doc = JSON.parse(request.body.toString());
    const file = Object.keys(doc._attachments)[0] as string;
    doc._attachments[file].data = Buffer.from('other bytes').toString('base64');
    expect(approvalHash({ ...request, body: Buffer.from(JSON.stringify(doc)) })).not.toBe(
      approvalHash(request),
    );
    expect(writes('npm-publish-tag.http')[0]?.summary.title).toBe(
      'Publish melete-demo@1.0.0 to npm (tag next)',
    );
    expect(writes('npm-publish-scoped-public.http')[0]?.summary.title).toBe(
      'Publish @alice/tool@0.2.0 to npm (tag latest), public',
    );
  });

  test('a publish shows the scripts that run when someone installs it', () => {
    const published = write(
      recordedFile(FIXTURES, 'edge-hand-written.http', [NPM_TOKEN_PLACEHOLDER]).find((entry) =>
        entry.request.body.toString().includes('postinstall'),
      )?.request as InterceptedRequest,
    );
    expect(published.summary.facts).toContainEqual({
      label: 'Scripts that run on install (0.3.0)',
      value: 'postinstall: node setup.js',
    });
  });

  test('unpublishing, deprecating and changing owners are shown as the record they leave', () => {
    expect(
      writes('npm-unpublish-version.http').map((w) => [w.summary.title, w.destructive]),
    ).toEqual([
      ['Change melete-demo on npm (versions kept: 1.1.0; owners: alice, bob; tags; time)', true],
      ['Delete the tarball x-1.0.0.tgz of melete-demo from npm', true],
    ]);
    expect(writes('npm-unpublish-all.http').map((w) => w.summary.title)).toEqual([
      'Unpublish every version of melete-demo from npm',
    ]);
    const [deprecated] = writes('npm-deprecate.http');
    expect(deprecated?.summary.title).toBe(
      'Change melete-demo on npm (versions kept: 1.0.0, 1.1.0; 1 deprecated; owners: alice, bob; tags; time)',
    );
    expect(deprecated?.summary.facts).toContainEqual({ label: 'Deprecated', value: '1.0.0: Old' });
    expect(writes('npm-owner-add.http').map((w) => w.summary.title)).toEqual([
      'Change melete-demo on npm (owners: alice, bob)',
    ]);
    // A star names only who starred it: nothing else is replaced.
    const [star] = writes('npm-star.http');
    expect(star?.summary.title).toBe('Change melete-demo on npm (users)');
    expect(star?.destructive).toBe(false);
  });

  test('tag, access, team and organisation changes say what they change', () => {
    expect(writes('npm-dist-tag-add.http').map((w) => w.summary.title)).toEqual([
      'Point the next tag of melete-demo at 1.0.0',
    ]);
    expect(writes('npm-dist-tag-rm.http').map((w) => w.summary.title)).toEqual([
      'Remove the next tag from melete-demo',
    ]);
    expect(writes('npm-access-public.http').map((w) => w.summary.title)).toEqual([
      'Make @alice/tool public',
    ]);
    expect(writes('npm-access-mfa.http').map((w) => w.summary.title)).toEqual([
      'Require two-factor authentication to publish @alice/tool',
    ]);
    expect(writes('npm-access-grant.http').map((w) => w.summary.title)).toEqual([
      'Give the team @alice:devs read-write on @alice/tool',
    ]);
    expect(writes('npm-org-set.http').map((w) => w.summary.title)).toEqual([
      'Add bob to the npm organisation alice as developer',
    ]);
  });

  test('a package is named the same however its scope is written, and an odd path names none', () => {
    const doc = { name: '@alice/tool', versions: {} };
    for (const target of [
      '/@alice%2ftool/-rev/1-a',
      '/@alice%2Ftool/-rev/1-a',
      '/@alice/tool/-rev/1-a',
    ])
      expect(write(put(target, doc)).payload.resource).toBe('@alice/tool');
    for (const target of [
      '/%2e%2e/melete-demo',
      '/melete-demo%5c..',
      '/melete-demo//x',
      '/%E0%A4%A',
    ])
      expect(write(put(target, { name: 'melete-demo' })).payload.resource).toBeUndefined();
    // A dot segment anywhere, escaped or not, is not read as the record it seems to name.
    for (const target of [
      '/melete-demo/-rev/..',
      '/melete-demo/-rev/%2e',
      '/melete-demo/./-rev/1-a',
    ])
      expect(write(put(target, { name: 'melete-demo', versions: {} })).operation).toBe('request');
    // A document naming another package than its path asks as the request itself.
    const mismatch = write(put('/other-name', { name: 'melete-demo', _attachments: { a: {} } }));
    expect(mismatch.operation).toBe('request');
    expect(
      npmAdapter.classify({ ...put('/x', {}), host: 'registry.example.com' }, config).kind,
    ).toBe('refuse');
  });

  test('the token goes as a bearer token, and the placeholder never travels', () => {
    const headers = upstreamHeaders(
      { authorization: `Bearer ${NPM_TOKEN_PLACEHOLDER}`, 'npm-command': 'publish' },
      [NPM_TOKEN_PLACEHOLDER],
    );
    expect(headers).toEqual({ 'npm-command': 'publish' });
    const sent = npmAdapter.authorize(
      {
        host: 'registry.npmjs.org',
        method: 'GET',
        target: '/-/whoami',
        headers,
        body: Buffer.alloc(0),
      },
      'npm_secret',
      config,
    );
    expect(sent.headers.authorization).toBe('Bearer npm_secret');
    expect(npmAdapter.placeholders(config)).toEqual({ [NPM_TOKEN_ENV]: NPM_TOKEN_PLACEHOLDER });
  });

  test('a held change is answered in the words npm prints', () => {
    const request = one('npm-publish.http', 2);
    const message =
      'Waiting for your approval in Melete: Publish melete-demo@1.0.0 to npm (tag latest).';
    const held = npmAdapter.heldAnswer?.(request, write(request), message, 403);
    expect(held?.status).toBe(403);
    expect(JSON.parse(held?.body.toString() ?? '{}')).toEqual({ error: message, message });
  });
});

describe('asking the npm registry whose token it is', () => {
  test('the account is read from whoami, and a refused token says so', async () => {
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const answer = (status: number, body: unknown) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({
          url: String(url),
          authorization: new Headers(init?.headers).get('authorization'),
        });
        return new Response(JSON.stringify(body), { status });
      }) as typeof fetch;
    expect(
      await npmAccount('npm_x', {
        fetch: answer(200, { username: 'alice' }),
        registry: 'https://r.test',
      }),
    ).toEqual({ ok: true, login: 'alice' });
    expect(seen).toEqual([{ url: 'https://r.test/-/whoami', authorization: 'Bearer npm_x' }]);
    expect(await npmAccount('npm_x', { fetch: answer(401, {}) })).toEqual({
      ok: false,
      code: 'credential_refused',
    });
    expect(seen.at(-1)?.url).toBe('https://registry.npmjs.org/-/whoami');
    expect(await npmAccount('npm_x', { fetch: answer(200, { username: 'not valid!' }) })).toEqual({
      ok: false,
      code: 'unavailable',
    });
  });
});
