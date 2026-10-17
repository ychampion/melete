/**
 * The service's log is for the operator, and on a host that serves other
 * people the operator is not those people. So no line may carry what someone
 * wrote, a file's contents, a prompt, a model's answer, or a credential: only
 * ids, codes, counts and short reasons.
 *
 * This reads every place the service writes to its output and refuses one
 * whose written values are named like content or a secret. Error messages
 * stay allowed: they are bounded reasons, and log-guard.ts takes out any
 * credential one quotes.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = import.meta.dir;

/** Names that hold content or a secret when they are written into a line. */
const FORBIDDEN = new Set([
  'prompt',
  'prompts',
  'content',
  'contents',
  'body',
  'transcript',
  'output',
  'completion',
  'reply',
  'answer',
  'messages',
  'html',
  'markdown',
  'subject',
  'snippet',
  'payload',
  'instructions',
  'password',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'api_key',
  'cookie',
  'authorization',
  'headers',
  'query',
  'input',
]);

/**
 * Values written on purpose that a name above would refuse, each with why
 * it carries no content. Keyed by file and the written expression.
 */
const ALLOWED: Record<string, string> = {
  // The run.log tool: it stores an attempt's progress note and prints nothing.
  'runs/service.ts input': 'run.log tool',
  // A HistoryFailure code (history-gateway.ts), never the provider's reply.
  'jobs/history-extend.ts answer.reason': 'summary failure code',
};

/** Command-line programs print to the person running them, not to a service log. */
const NOT_THE_SERVICE = [
  /(^|\/)cli\.ts$/,
  /(^|\/)account\/reset-password\.ts$/,
  /(^|\/)companies\/demo\.ts$/,
  // Child processes whose output is a JSON answer to the service, not a log.
  /(^|\/)learning\/gate-worker\.ts$/,
  /(^|\/)workers\/browser\/entry\.ts$/,
  // A script run inside an MCP container, quoted as a string.
  /(^|\/)connectors\/mcp-stdio-docker\.ts$/,
];

/**
 * Writes to the process's output, and the `log`, `say`, `warn` and `report`
 * lines services are handed, which write to stderr by default, whether called
 * bare, on `this`, `deps` or `options`, or only when given (`log?.(…)`).
 */
const CALL =
  /(?<![\w.])(?:console\.(?:log|info|warn|error|debug)|process\.std(?:out|err)\.write|(?:(?:this|deps|options)\.)?(?:log|say|warn|report)(?:\?\.)?)\(/g;

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules') yield* sources(path);
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
      yield path;
  }
}

/** The text between a call's opening parenthesis and its matching close. */
function argumentsAt(source: string, start: number): string {
  let depth = 1;
  let at = start;
  while (at < source.length && depth > 0) {
    const char = source[at];
    if (char === '(') depth++;
    else if (char === ')') depth--;
    at++;
  }
  return source.slice(start, at - 1);
}

/** The expressions a call writes: each `${…}` in a template, and anything outside a literal. */
function writtenExpressions(args: string): string[] {
  const interpolated = [...args.matchAll(/\$\{([^}]*)\}/g)].map((match) => match[1] ?? '');
  const outside = args
    .replace(/`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, ' ')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return [...interpolated, ...outside].map((expression) => expression.replace(/\s+/g, ' ').trim());
}

/** Names in an expression that say it holds content or a secret. */
function forbiddenNames(expression: string): string[] {
  const words = expression
    // An error's message is a reason, not content; log-guard.ts redacts what it quotes.
    .replace(/\b\w*(?:error|failure|failed|cleanup|warning|cause|err)\.message\b/gi, ' ')
    .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, ' ')
    .match(/[A-Za-z_][A-Za-z0-9_]*/g);
  return (words ?? []).filter((word) => FORBIDDEN.has(word.toLowerCase()));
}

type Site = { where: string; expression: string; names: string[] };

function scan(): { sites: number; leaks: Site[] } {
  let sites = 0;
  const leaks: Site[] = [];
  for (const path of sources(ROOT)) {
    const file = relative(ROOT, path).replaceAll('\\', '/');
    if (NOT_THE_SERVICE.some((pattern) => pattern.test(file))) continue;
    const source = readFileSync(path, 'utf8');
    let line = 1;
    let counted = 0;
    for (const match of source.matchAll(CALL)) {
      sites++;
      for (; counted < (match.index ?? 0); counted++) if (source[counted] === '\n') line++;
      for (const expression of writtenExpressions(
        argumentsAt(source, (match.index ?? 0) + match[0].length),
      )) {
        const names = forbiddenNames(expression);
        if (names.length > 0 && !ALLOWED[`${file} ${expression}`])
          leaks.push({ where: `${file}:${line}`, expression, names });
      }
    }
  }
  return { sites, leaks };
}

describe('service log lines', () => {
  test('write no message text, file contents, prompts, model output or secrets', () => {
    const { sites, leaks } = scan();
    // The scan found the call sites at all: a broken pattern would pass vacuously.
    expect(sites).toBeGreaterThan(100);
    expect(leaks).toEqual([]);
  }, 30_000);

  test('the scan refuses a line that writes content or a secret', () => {
    expect(forbiddenNames('message.body')).toEqual(['body']);
    expect(forbiddenNames('request.prompt.slice(0, 80)')).toEqual(['prompt']);
    expect(forbiddenNames('creds.password')).toEqual(['password']);
    expect(forbiddenNames('error.message')).toEqual([]);
    expect(forbiddenNames("failed === 1 ? '' : 's'")).toEqual([]);
    const call = ['`voice: $', '{kind} failed: $', '{error.message}\\n`'].join('');
    expect(writtenExpressions(call)).toEqual(['kind', 'error.message']);
  });
});
