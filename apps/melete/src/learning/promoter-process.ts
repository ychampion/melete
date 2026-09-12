import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { GateInput } from './gate.ts';

const decision = z.strictObject({
  decision: z.enum(['reject', 'select', 'allow_canary']),
  reason: z.string().min(1).max(300),
  definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
});

let trustedBundle: Promise<string> | undefined;
async function buildTrustedBundle() {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL('./gate-worker.ts', import.meta.url))],
    target: 'node',
    format: 'esm',
    minify: true,
  });
  const output = result.outputs[0];
  if (!result.success || result.outputs.length !== 1 || !output)
    throw new Error('gate_build_failed');
  return output.text();
}

/** Trusted module launcher shared by the gate and its permission-boundary probe. */
export function launchRestrictedModule(path: string, input: unknown) {
  const node = Bun.which('node');
  if (!node) throw new Error('Node with --permission is required for promotion');
  return Bun.spawn({
    cmd: [node, '--permission', `--allow-fs-read=${path}`, path],
    env:
      process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {},
    stdin: new Blob([JSON.stringify(input)]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

/** No write grant, credential environment, subprocess grant, or arbitrary source enters this process. */
export async function openPromoterProcess() {
  const node = Bun.which('node');
  if (!node) throw new Error('Node with --permission is required for promotion');
  const directory = await mkdtemp(join(tmpdir(), 'melete-learning-gate-'));
  const path = join(directory, 'gate.mjs');
  try {
    // Compile immutable trusted source once; each decision still has its own restricted child.
    trustedBundle ??= buildTrustedBundle();
    await writeFile(path, await trustedBundle);
    // Keep the exact trusted bytes available for audit without granting the child directory access.
    const source = await readFile(path);
    return {
      source,
      async decide(input: GateInput) {
        const child = launchRestrictedModule(path, input);
        const timeout = setTimeout(() => child.kill(), 10000);
        try {
          const stdout = await new Response(child.stdout).text();
          const stderr = await new Response(child.stderr).text();
          const code = await child.exited;
          if (code !== 0 || stdout.length > 2048)
            throw new Error(
              `promoter_process_failed:${code}:${stderr ? 'stderr_recorded' : 'no_stderr'}`,
            );
          const parsed = decision.parse(JSON.parse(stdout));
          if (parsed.definitionHash !== input.definitionHash)
            throw new Error('promoter_definition_mismatch');
          return parsed;
        } finally {
          clearTimeout(timeout);
        }
      },
      async close() {
        await rm(path, { force: true });
        await rmdir(directory);
      },
    };
  } catch (error) {
    await rm(path, { force: true });
    await rmdir(directory);
    throw error;
  }
}
