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
