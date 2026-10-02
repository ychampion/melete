import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const SOURCE = join(import.meta.dir, '..');
/** Where a job's workspace path may be built. */
const ALLOWED = new Set(['runtime/workspace-fs.ts']);

/** Names the workspace root goes by in this code. */
const WORK_ROOT = /workRoot|MELETE_WORK_DIR|workspaceRoot/;
/** Names a job id goes by: `job_id`, `jobId`, `sourceJobId`. */
const JOB_ID = /job_?id\b/i;

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** The argument text of each call to `name(`, matched to its closing parenthesis. */
function calls(text: string, name: RegExp): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(new RegExp(`${name.source}\\(`, 'g'))) {
    let depth = 1;
    let end = (match.index ?? 0) + match[0].length;
    const start = end;
    while (end < text.length && depth > 0) {
      if (text[end] === '(') depth += 1;
      else if (text[end] === ')') depth -= 1;
      end += 1;
    }
    found.push(text.slice(start, end - 1));
  }
  return found;
}

/** The places in one file that build a path from the workspace root and a job id. */
function workspaceJoins(source: string): string[] {
  const text = withoutComments(source);
  const found: string[] = [];
  // A path joined or resolved with a job id: under the workspace root, or under
  // a base that is (the realpath of) it.
  for (const args of calls(text, /(?<![\w.])(?:path\.)?(?:join|resolve)/))
    if (JOB_ID.test(args)) found.push(`join(${args})`);
  // A path checked component by component from a job id down, or from the root.
  for (const args of calls(text, /\bnoLinks/))
    if (JOB_ID.test(args) || WORK_ROOT.test(args)) found.push(`noLinks(${args})`);
  if (WORK_ROOT.test(text)) {
    // A job id as the first segment of a path, beside the workspace root.
    for (const match of text.matchAll(
      /\[\s*(?:[\w.]+\.)?\w*job_?id\b(?:\s+as\s+string)?\s*(?:\]|,\s*\.\.\.\s*(?:segmentsFor|portable|segments)\b)/gi,
    ))
      found.push(match[0]);
    // A path written out as text.
    for (const match of text.matchAll(/`[^`]*\$\{[^}]*\}[^`]*`/g))
      if (WORK_ROOT.test(match[0]) && JOB_ID.test(match[0])) found.push(match[0]);
  }
  return found;
}

async function workspaceJoinsUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  for await (const file of new Bun.Glob('**/*.ts').scan({ cwd: root })) {
    const name = file.replaceAll('\\', '/');
    if (name.endsWith('.test.ts') || ALLOWED.has(name)) continue;
    const text = await readFile(join(root, file), 'utf8');
    for (const place of workspaceJoins(text))
      found.push(`${relative(SOURCE, join(root, file))}: ${place.replace(/\s+/g, ' ')}`);
  }
  return found.sort();
}

test('only the workspace module joins the workspace root with a job id', async () => {
  expect(await workspaceJoinsUnder(SOURCE)).toEqual([]);
});

test('the workspace check finds each way a job workspace path has been built', () => {
  expect(
    workspaceJoins("const folder = path.join(options.workRoot, ctx.job_id, 'device');"),
  ).toHaveLength(1);
  expect(workspaceJoins('const target = path.join(base, jobId);')).toHaveLength(1);
  expect(
    workspaceJoins('return noLinks(base, [ctx.job_id, ...segmentsFor(relative)], false);'),
  ).toHaveLength(1);
  expect(
    workspaceJoins(`const base = await realpath(area === 'work' ? options.workRoot : options.spacesRoot);
    const scope = area === 'work' ? [ctx.job_id] : [ctx.space_id, 'artifacts'];
    return noLinks(base, [...scope, ...segmentsFor(relative)], create);`),
  ).not.toHaveLength(0);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text with a template literal
  expect(workspaceJoins('const dir = `${options.workRoot}/${jobId}`;')).not.toHaveLength(0);
  // The spaces root and job ids kept apart are not a workspace path.
  expect(
    workspaceJoins(
      "const file = await noLinks(await realpath(spacesRoot), [ctx.space_id, 'artifacts'], false);",
    ),
  ).toEqual([]);
  expect(
    workspaceJoins('await syncIn({ workRoot: options.workRoot, jobId: ctx.job_id });'),
  ).toEqual([]);
});
