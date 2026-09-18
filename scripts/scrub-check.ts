/**
 * `bun run scrub:check` fails when a tracked file carries something that belongs
 * to one machine, one session, or one stage of the build rather than to the
 * repository: a local path, a working-note phrase, or an internal work code. It
 * runs as part of `bun run lint`.
 *
 * The patterns are deliberately literal. This file and its test are the two
 * tracked files that have to spell them out, so they are exempt.
 */
import { fileURLToPath } from 'node:url';

/**
 * An absolute Windows user path, a Linux root home, a throwaway worktree name,
 * and two phrases that only ever described the mechanics of a working session.
 */
const SESSION_TRACE = /C:\/Users|\/root\/|melete-oss-|fix cycle|shared lock/;

/**
 * An internal work code: `W` and one or two digits, with an optional trailing
 * letter (`W1`, `W10a`, `W16d`). These named pieces of work while the project
 * was being built and mean nothing to a reader. Both cases are refused, because
 * the codes were written upper-case in prose and lower-case inside identifiers,
 * temporary directory names, queue names and fixture strings.
 *
 * The token has to stand alone, which is what keeps ordinary text out of it:
 * `W3C` and `switch1` keep a word character against the token, and the trailing
 * exception lets a link to `w3.org` through.
 */
const WORK_CODE = /(?<![A-Za-z0-9_])[Ww]\d{1,2}[a-z]?(?![A-Za-z0-9_])(?!\.(?:org|com|net))/;

/** What a contributor should do about each rule, printed only when it fires. */
const GUIDANCE: Record<string, string> = {
  'session trace':
    'A local path or session phrase belongs to one machine or one run. Describe the repository instead.',
  'work code':
    'A work code named a piece of work while the project was being built and means nothing to a reader. Say what the thing is — the service, the broker, the memory core — not the item it came from.',
};

/**
 * Lines a matching pattern is allowed on, keyed by tracked path. The runtime
 * image build removes the build container's own uv package cache; that is the
 * image's path, not a path on a contributor's machine.
 */
const ALLOWED: Record<string, RegExp> = {
  'packages/runtime-hermes/Dockerfile': /rm -rf \/root\/\.cache\/uv/,
};

/** The two files that have to spell the patterns out to enforce and test them. */
const SPELLS_THE_PATTERNS = new Set(['scripts/scrub-check.ts', 'scripts/scrub-check.test.ts']);

/**
 * Work codes stay legal under `.agents/notes`, which README describes as the
 * retained engineering history. Each note records a decision and the evidence
 * behind it, and several are filed under the code of the work that produced
 * them, so scrubbing them would rewrite the record rather than tidy it. Nothing
 * the repository ships reads from here.
 */
const RETAINED_HISTORY = '.agents/notes/';

export type Finding = { file: string; line: number; text: string; rule: string };

/** The rule a line breaks, or null when it carries nothing that must be scrubbed. */
export function violation(file: string, line: string): string | null {
  if (SPELLS_THE_PATTERNS.has(file)) return null;
  if (ALLOWED[file]?.test(line)) return null;
  if (SESSION_TRACE.test(line)) return 'session trace';
  if (!file.startsWith(RETAINED_HISTORY) && WORK_CODE.test(line)) return 'work code';
  return null;
}

/** Every line of one tracked file that must not be committed as written. */
export function scanText(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const rule = violation(file, line);
    if (rule) findings.push({ file, line: index + 1, text: line.trim(), rule });
  }
  return findings;
}

/** The failure a contributor reads, with one line of guidance per rule that fired. */
export function report(findings: Finding[]): string {
  const lines = [`scrub:check found ${findings.length} line(s) that must not be committed:`];
  for (const finding of findings)
    lines.push(`  ${finding.rule}  ${finding.file}:${finding.line}: ${finding.text}`);
  for (const rule of new Set(findings.map((finding) => finding.rule)))
    lines.push(GUIDANCE[rule] ?? '');
  return `${lines.join('\n')}\n`;
}

/** The tracked files, minus the lockfile. */
export function trackedFiles(root: string): string[] {
  const listed = Bun.spawnSync(['git', 'ls-files', '-z', '--', '.', ':!bun.lock'], { cwd: root });
  if (listed.exitCode !== 0) throw new Error(listed.stderr.toString() || 'git ls-files failed');
  return listed.stdout.toString().split('\0').filter(Boolean);
}

/**
 * Every tracked file scanned. A NUL byte in the leading bytes means the file is
 * binary and is skipped; that is what keeps the screenshots under
 * `apps/web/docs/screens` and `docs/media` out, whose bytes match by accident.
 */
export async function scrub(root: string): Promise<{ files: string[]; findings: Finding[] }> {
  const files = trackedFiles(root);
  const findings: Finding[] = [];
  for (const file of files) {
    const bytes = await Bun.file(`${root}${file}`).arrayBuffer();
    if (new Uint8Array(bytes.slice(0, 8192)).includes(0)) continue;
    findings.push(...scanText(file, new TextDecoder().decode(bytes)));
  }
  return { files, findings };
}

if (import.meta.main) {
  const { files, findings } = await scrub(fileURLToPath(new URL('..', import.meta.url)));
  if (findings.length > 0) {
    process.stderr.write(report(findings));
    process.exit(1);
  }
  process.stdout.write(`scrub:check passed (${files.length} tracked files)\n`);
}
