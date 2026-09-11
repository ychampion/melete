import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const testName = /[._](?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/;

// Approximate seconds balance the known slow files; these are scheduling hints,
// never timeouts or reasons to skip a test. New files are always discovered.
const weights: Record<string, number> = {
  'apps/melete/test/integration/responsibility.test.ts': 60,
  'apps/melete/test/integration/runner.test.ts': 50,
  'apps/melete/src/knowledge/routes.test.ts': 32,
  'apps/melete/test/integration/memory.test.ts': 31,
  'packages/knowledge/src/space.test.ts': 26,
  'packages/knowledge/src/lint.test.ts': 26,
  'apps/melete/test/integration/waits.test.ts': 25,
  'apps/melete/test/integration/events.test.ts': 23,
  'packages/knowledge/src/retraction.test.ts': 23,
  'apps/melete/test/integration/auth.test.ts': 21,
  'apps/melete/test/integration/submissions.test.ts': 20,
  'apps/melete/test/integration/replies.test.ts': 17,
  'apps/melete/test/integration/jobs.test.ts': 16,
  'packages/knowledge/src/mediation.test.ts': 15,
  'conformance/memory/breaks.test.ts': 8,
  'apps/melete/test/integration/attention.test.ts': 7,
  'apps/mock-api/src/app.test.ts': 4,
};

/** Match Bun's test suffixes and directory exclusions without following links. */
export async function discoverTests(directory = root): Promise<string[]> {
  const files: string[] = [];
  async function visit(relative: string) {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) await visit(path);
      } else if (entry.isFile() && testName.test(entry.name)) {
        files.push(path);
      }
    }
  }
  await visit('');
  return files.sort();
}

type Group = { files: string[]; weight: number };
const weight = (file: string) =>
  weights[file] ?? (file.startsWith('apps/melete/test/integration/') ? 4 : 0.1);

/** Whole files stay serial so fixture state and memory falsifiers cannot race. */
export function partitionTests(files: readonly string[]): [Group, Group] {
  const groups: [Group, Group] = [
    { files: [], weight: 0 },
    { files: [], weight: 0 },
  ];
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const group = groups[0].weight <= groups[1].weight ? groups[0] : groups[1];
    group.files.push(file);
    group.weight += weight(file);
  }
  return groups;
}

async function runTests(): Promise<number> {
  const files = await discoverTests();
  if (files.length < 2) throw new Error('The full suite requires at least two test files');
  const groups = partitionTests(files);
  process.stdout.write(`Running ${files.length} test files in two serial processes.\n`);
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    for (const [index, group] of groups.entries()) {
      process.stdout.write(`Test process ${index + 1}: ${group.files.length} files.\n`);
      // Ordinary test processes keep one preload-owned Postgres server each.
      // Bun's parallel workers repeat preload lifecycle hooks for every file.
      children.push(
        Bun.spawn({
          cmd: [
            process.execPath,
            'test',
            '--max-concurrency=1',
            '--timeout=30000',
            ...group.files.map((f) => `./${f}`),
          ],
          cwd: root,
          stdin: 'ignore',
          stdout: 'inherit',
          stderr: 'inherit',
        }),
      );
    }
  } catch (error) {
    for (const child of children) child.kill();
    await Promise.allSettled(children.map((child) => child.exited));
    throw error;
  }
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    for (const child of children) child.kill();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const results = await Promise.allSettled(
      children.map(async (child, index) => {
        const code = await child.exited;
        process.stdout.write(`Test process ${index + 1} exited with ${code}.\n`);
        return code;
      }),
    );
    for (const result of results) {
      if (result.status === 'rejected') process.stderr.write(`${String(result.reason)}\n`);
    }
    return !interrupted &&
      results.every((result) => result.status === 'fulfilled' && result.value === 0)
      ? 0
      : 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

if (import.meta.main) {
  const started = performance.now();
  try {
    process.exitCode = await runTests();
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  } finally {
    process.stdout.write(
      `Full suite duration: ${((performance.now() - started) / 1000).toFixed(2)}s.\n`,
    );
  }
}
