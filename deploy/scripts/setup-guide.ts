/**
 * Runs SETUP-WITH-AN-AGENT.md's main path the way an agent would, so the guide
 * and what actually works cannot drift apart. The setup-guide workflow uses it
 * on a clean runner.
 *
 *   bun run deploy/scripts/setup-guide.ts script
 *     prints the guide's `bash setup` blocks, in order, as one Bash script
 *   bun run deploy/scripts/status.ts --json | bun run deploy/scripts/setup-guide.ts expect <before|after>
 *     checks the report: everything passes but the model, which waits for a key
 *     pasted into the app, and, before the account is created, the account
 *
 * The blocks are read from the page itself rather than copied, so a command
 * changed in the guide is the command that is run.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Check } from './status.ts';

export const GUIDE = 'SETUP-WITH-AN-AGENT.md';

/** The bodies of the fenced blocks whose info string is `bash setup`, indentation removed. */
export function setupBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const open = /^(\s*)```bash setup\s*$/.exec(lines[index] ?? '');
    if (!open) continue;
    const indent = open[1]?.length ?? 0;
    const body: string[] = [];
    for (index += 1; index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? ''); index += 1)
      body.push((lines[index] ?? '').slice(indent));
    if (index >= lines.length) throw new Error(`${GUIDE}: a setup block is never closed`);
    blocks.push(body.join('\n'));
  }
  return blocks;
}

/** One script that stops at the first failing command and shows each block as it runs. */
export function setupScript(blocks: readonly string[]): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    ...blocks.flatMap((block, index) => [
      `echo '==> ${GUIDE}, setup block ${index + 1} of ${blocks.length}'`,
      block,
    ]),
    '',
  ].join('\n');
}

/**
 * What is wrong with a status report at this point of the setup; empty when it is
 * as the guide says it should be. The model is never required: the guide leaves
 * its key to the person. The account is a warning until it is created.
 */
export function unexpected(checks: readonly Check[], stage: 'before' | 'after'): string[] {
  const problems = checks.flatMap((check) => {
    if (check.name === 'Model') return check.level === 'fail' ? [check] : [];
    if (check.name === 'Account' && stage === 'before')
      return check.level === 'warn' ? [] : [check];
    return check.level === 'ok' ? [] : [check];
  });
  const missing = [
    'Docker',
    'Disk',
    'Configuration',
    'Images',
    'Services',
    'API',
    'Account',
  ].filter((name) => !checks.some((check) => check.name === name));
  return [
    ...problems.map((check) => `${check.name}: ${check.level}, ${check.detail}`),
    ...missing.map((name) => `${name}: not reported`),
  ];
}

if (import.meta.main) {
  const [command, stage] = process.argv.slice(2);
  if (command === 'script') {
    const blocks = setupBlocks(readFileSync(resolve(import.meta.dir, '../..', GUIDE), 'utf8'));
    process.stdout.write(setupScript(blocks));
  } else if (command === 'expect' && (stage === 'before' || stage === 'after')) {
    const report = JSON.parse(await Bun.stdin.text()) as { checks: Check[] };
    const problems = unexpected(report.checks, stage);
    for (const check of report.checks)
      process.stdout.write(`${check.level} ${check.name}: ${check.detail}\n`);
    for (const problem of problems) process.stderr.write(`unexpected: ${problem}\n`);
    process.exit(problems.length ? 1 : 0);
  } else {
    process.stderr.write('Usage: setup-guide.ts script | expect <before|after>\n');
    process.exit(2);
  }
}
