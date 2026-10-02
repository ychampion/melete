import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const SOURCE = join(import.meta.dir, '..');
/** Where a job's workspace path may be built. */
const ALLOWED = new Set([
  'runtime/workspace-fs.ts',
  // Test harnesses that lay out a workspace root in a temporary directory.
  'sandbox/conformance.ts',
  'sandbox/workspace-conformance.ts',
]);

/** Names the workspace root goes by in this code. */
const WORK_ROOT = /workRoot|MELETE_WORK_DIR|workspaceRoot/;
/** Names a job id goes by: `job_id`, `jobId`, `sourceJobId`. */
const JOB_ID = /job_?id\b/i;

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** The text between the parenthesis at `open` and the one that closes it. */
function argumentsAt(text: string, open: number): string {
  let depth = 1;
  let end = open + 1;
  while (end < text.length && depth > 0) {
    if (text[end] === '(') depth += 1;
    else if (text[end] === ')') depth -= 1;
    end += 1;
  }
  return text.slice(open + 1, end - 1);
}

/** The argument text of each call to `name(`, matched to its closing parenthesis. */
function calls(text: string, name: RegExp): string[] {
  return [...text.matchAll(new RegExp(`${name.source}\\(`, 'g'))].map((match) =>
    argumentsAt(text, (match.index ?? 0) + match[0].length - 1),
  );
}

/** Arguments split at the commas outside any bracket. */
function topLevel(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < args.length; index += 1) {
    const char = args[index] ?? '';
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(args.slice(start, index));
      start = index + 1;
    }
  }
  if (args.slice(start).trim()) parts.push(args.slice(start));
  return parts;
}

/**
 * This module's own functions that take the root and a job id, and the two
 * older wrappers over it in sandbox/workspace.ts.
 */
const ENTRY_POINTS = new Set(['jobWorkspace', 'readWorkspaceFile', 'writeWorkspaceFile']);

/** Calls that build, check, open or remove a path. */
const PATH_CALLS =
  /^(?:join|resolve|noLinks|removeConfined|rm|rmdir|access|lstat|stat|mkdir|readdir|open|realpath|rename|writeFile|readFile|exists|existsSync)$/;

/** An argument that is the workspace root itself, perhaps resolved or awaited. */
const ROOT_ARGUMENT =
  /^(?:await\s+)?(?:(?:path\.)?(?:resolve|realpath(?:Sync)?)\()?\s*[\w$.?]*(?:workRoot|MELETE_WORK_DIR)\s*\)?$/;

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
  // A path or file operation, or any workspace helper, handed the workspace
  // root and then a name, whatever the name is called: a join, a removal, a
  // check. Only this module takes the root and a job id together.
  for (const match of text.matchAll(/(?<![\w.])((?:path\.|fs\.)?([A-Za-z_$][\w$]*))\(/g)) {
    const callee = match[2] ?? '';
    if (ENTRY_POINTS.has(callee) || !(PATH_CALLS.test(callee) || /workspace/i.test(callee)))
      continue;
    const open = (match.index ?? 0) + match[0].length - 1;
    const [first, ...rest] = topLevel(argumentsAt(text, open));
    if (
      first !== undefined &&
      ROOT_ARGUMENT.test(first.trim()) &&
      rest.some((argument) => !/^\s*(?:(['"`])[^'"`$]*\1|\{[\s\S]*\})\s*$/.test(argument))
    )
      found.push(`${match[1]}(${[first, ...rest].join(',')})`);
  }
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
}, 30_000);

test('the workspace check finds each way a job workspace path has been built', () => {
  expect(
    workspaceJoins("const folder = path.join(options.workRoot, ctx.job_id, 'device');"),
  ).not.toHaveLength(0);
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
  // Whatever the job id is called, once it follows the root.
  expect(workspaceJoins('const workspace = join(workRoot, id);')).not.toHaveLength(0);
  expect(
    workspaceJoins('await removeConfined(await realpath(options.workRoot), name, beforeRetry);'),
  ).not.toHaveLength(0);
  expect(
    workspaceJoins('const held = await clearJobWorkspaces(roots.workRoot, ids, retry);'),
  ).not.toHaveLength(0);
  // The spaces root and job ids kept apart are not a workspace path, and
  // neither is a fixed folder under the root.
  expect(workspaceJoins("const directory = join(workRoot, '.melete-engines');")).toEqual([]);
  expect(
    workspaceJoins(
      "const file = await noLinks(await realpath(spacesRoot), [ctx.space_id, 'artifacts'], false);",
    ),
  ).toEqual([]);
  expect(
    workspaceJoins('await syncIn({ workRoot: options.workRoot, jobId: ctx.job_id });'),
  ).toEqual([]);
});
