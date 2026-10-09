import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { type BrowserObservation, browserArtifactSink } from './artifacts.ts';

const root = await mkdtemp(join(tmpdir(), 'melete-browser-artifacts-'));
afterAll(() => rm(root, { recursive: true, force: true }));

/** Records each artifact row the sink would insert, with its size and type. */
function recorder() {
  const rows: Array<{ mime: unknown; size: unknown }> = [];
  const sql = ((_strings: TemplateStringsArray, ...values: unknown[]) => {
    rows.push({ mime: values[5], size: values[6] });
    return Promise.resolve([]);
  }) as unknown as Sql;
  return { rows, sink: browserArtifactSink(sql, root) };
}

const PICTURE = Buffer.from('picture of the page').toString('base64');
const look = (fields: Partial<BrowserObservation>): BrowserObservation => ({
  id: 'obs_1',
  url: 'https://public.example/',
  tree: '- heading "Public page" [level=1]',
  screenshot: PICTURE,
  schema: [],
  ...fields,
});

test('a page that loaded keeps its tree and picture', async () => {
  const { rows, sink } = recorder();
  const stored = await sink({ space_id: 'sp_kept', job_id: 'job_kept' }, look({}));
  expect(rows.map((row) => row.mime)).toEqual(['text/plain', 'image/png']);
  expect(stored.tree).toBeDefined();
  expect(stored.screenshot).toBeDefined();
});

test('an empty capture, a blank tab and an error page leave no file and no card', async () => {
  const { rows, sink } = recorder();
  const scope = { space_id: 'sp_junk', job_id: 'job_junk' };
  // The page's picture is kept; its empty tree is not.
  const empty = await sink(scope, look({ tree: '  \n' }));
  expect(rows.map((row) => row.mime)).toEqual(['image/png']);
  expect(empty.tree).toBeUndefined();
  for (const url of ['chrome-error://chromewebdata/', 'about:blank', 'not a url']) {
    const stored = await sink(scope, look({ url, tree: '- text: This site can’t be reached' }));
    expect(stored.tree).toBeUndefined();
    expect(stored.screenshot).toBeUndefined();
    // What the look said is still returned, for the agent to read.
    expect(stored.url).toBe(url);
  }
  expect(rows).toHaveLength(1);
  expect(rows.every((row) => Number(row.size) > 0)).toBe(true);
  expect(await readdir(join(root, 'sp_junk', 'artifacts', 'browser'))).toHaveLength(1);
});
