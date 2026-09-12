/**
 * `bun run scrub:check` fails when a tracked file carries a local path or a
 * working-note phrase that belongs to one machine or one session, not to the
 * repository. It runs as part of `bun run lint`.
 *
 * The patterns are deliberately literal: an absolute Windows user path, a Linux
 * root home, a per-lane worktree name, and two phrases that only ever described
 * the mechanics of a working session. This file is the one tracked file that
 * has to spell them out, so it skips itself.
 */
import { fileURLToPath } from 'node:url';

const PATTERN = /C:\/Users|\/root\/|melete-oss-|fix cycle|shared lock/;

/**
 * Lines a matching pattern is allowed on, keyed by tracked path. The runtime
 * image build removes the build container's own uv package cache; that is the
 * image's path, not a path on a contributor's machine.
 */
const ALLOWED: Record<string, RegExp> = {
  'packages/runtime-hermes/Dockerfile': /rm -rf \/root\/\.cache\/uv/,
};

const root = fileURLToPath(new URL('..', import.meta.url));
const listed = Bun.spawnSync(['git', 'ls-files', '-z', '--', '.', ':!bun.lock'], { cwd: root });
if (listed.exitCode !== 0) {
  process.stderr.write(listed.stderr.toString());
  process.exit(listed.exitCode);
}
const SELF = 'scripts/scrub-check.ts';
const files = listed.stdout
  .toString()
  .split('\0')
  .filter((file) => file && file !== SELF);

const findings: string[] = [];
for (const file of files) {
  const bytes = await Bun.file(`${root}${file}`).arrayBuffer();
  const sample = new Uint8Array(bytes.slice(0, 8192));
  if (sample.includes(0)) continue; // binary
  const text = new TextDecoder().decode(bytes);
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!PATTERN.test(line)) continue;
    if (ALLOWED[file]?.test(line)) continue;
    findings.push(`${file}:${index + 1}: ${line.trim()}`);
  }
}

if (findings.length > 0) {
  process.stderr.write(
    `scrub:check found ${findings.length} line(s) that must not be committed:\n`,
  );
  for (const finding of findings) process.stderr.write(`  ${finding}\n`);
  process.exit(1);
}
process.stdout.write(`scrub:check passed (${files.length} tracked files)\n`);
