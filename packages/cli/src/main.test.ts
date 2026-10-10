import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogsRefusal, logsArguments, runLogs } from './commands/logs.ts';
import { main, parseArguments } from './main.ts';
import { temporaryDeployDir, testContext, writeEnv } from './testing.ts';

describe('melete logs', () => {
  test('services and the known options pass through to Compose', () => {
    expect(logsArguments(['melete', '--since', '1h', '--tail', '100', '-f'])).toEqual([
      '--since',
      '1h',
      '--tail',
      '100',
      '--follow',
      'melete',
    ]);
  });

  test('anything else is refused', () => {
    expect(() => logsArguments(['--tail', 'many'])).toThrow(LogsRefusal);
    expect(() => logsArguments(['--since'])).toThrow(LogsRefusal);
    expect(() => logsArguments(['--no-log-prefix'])).toThrow(LogsRefusal);
    expect(() => logsArguments(['Melete;rm'])).toThrow(LogsRefusal);
  });

  test("the contract's overlay files are given to Compose", async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(deployDir, 'melete.deploy.json'), '{"contract":1,"overlays":["browser"]}');
    const context = testContext(deployDir);
    expect(await runLogs(context, ['browser'])).toBe(0);
    expect(context.attached[0]?.join(' ')).toMatch(/docker-compose\.browser\.yml logs browser$/);
  });

  const ATTEMPT = 'att_01m4k68ytkpakvwpf4ta2hgnyg';
  const attempts = () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, { MELETE_SANDBOX_PROJECT: 'melete-1a2b3c4d' });
    return testContext(deployDir, [
      [
        'docker ps --all --filter label=com.melete.project=melete --filter label=com.melete.attempt',
        { code: 0, stdout: `melete-${ATTEMPT}\tExited (0) 2 minutes ago\t${ATTEMPT}\n` },
      ],
      [
        'docker ps --all --filter label=com.melete.sandbox --filter label=melete.project=melete-1a2b3c4d',
        { code: 0, stdout: 'melete-sbx-desk\tUp 3 hours\tdesk\n' },
      ],
    ]);
  };

  test("--attempts lists this installation's attempt containers, found by its labels", async () => {
    const context = attempts();
    expect(await runLogs(context, ['--attempts'])).toBe(0);
    expect(context.printed()).toContain(`melete-${ATTEMPT}\tExited (0) 2 minutes ago`);
    expect(context.attached).toEqual([]);
  });

  test('an attempt id shows that container with the same options', async () => {
    const context = attempts();
    expect(await runLogs(context, ['--attempts', ATTEMPT, '--tail', '50', '-t'])).toBe(0);
    expect(context.attached).toEqual([
      ['docker', 'logs', '--tail', '50', '--timestamps', `melete-${ATTEMPT}`],
    ]);
  });

  test("--computers finds the agents' computers by the installation's sandbox label", async () => {
    const context = attempts();
    expect(await runLogs(context, ['--computers', 'desk', '-f'])).toBe(0);
    expect(context.attached).toEqual([['docker', 'logs', '--follow', 'melete-sbx-desk']]);
  });

  test('a name that is not one of them is refused, and so is asking for both', async () => {
    const context = attempts();
    expect(await runLogs(context, ['--attempts', 'att_unknown'])).toBe(2);
    expect(context.errors()).toContain('No attempt container of this installation');
    expect(() => logsArguments(['--attempts', '--computers'])).toThrow(LogsRefusal);
  });
});

describe('the melete command', () => {
  test('global options are read wherever they stand', () => {
    expect(
      parseArguments(['status', '--json', '--deploy-dir', '/srv/melete/deploy']),
    ).toMatchObject({
      command: 'status',
      json: true,
      rest: [],
    });
    expect(parseArguments(['set', 'WEB_PORT=1']).rest).toEqual(['WEB_PORT=1']);
  });

  test('an unknown command or a stray argument is refused', async () => {
    const deployDir = temporaryDeployDir();
    const make = () => testContext(deployDir);
    expect(await main(['deploy-everything'], make)).toBe(2);
    expect(await main(['check', 'extra'], make)).toBe(2);
  });

  test("a directory that is not a checkout's deploy directory is refused", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'melete-not-deploy-'));
    const context = testContext(elsewhere);
    expect(await main(['check', '--deploy-dir', elsewhere], () => context)).toBe(2);
    expect(context.errors()).toContain("is not a checkout's deploy directory");
  });
});
