import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogsRefusal, logsArguments, runLogs } from './commands/logs.ts';
import { interruption, main, parseArguments } from './main.ts';
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
  /** Every agent computer on the engine, with the sandbox project and installation each names. */
  const COMPUTERS = [
    'melete-sbx-desk\tUp 3 hours\tdesk\t"melete-1a2b3c4d"\t""',
    // This installation's, made before MELETE_SANDBOX_PROJECT changed.
    'melete-sbx-old-sbx_a\tExited (0) 1 day ago\tmelete-sbx-old-sbx_a\t"old"\t"melete"',
    // Another installation's, under the same sandbox project.
    'melete-sbx-melete-1a2b3c4d-sbx_b\tUp 1 hour\tmelete-sbx-melete-1a2b3c4d-sbx_b\t"melete-1a2b3c4d"\t"other"',
    // Made before computers named their installation, under another sandbox project.
    'melete-sbx-theirs-sbx_c\tUp 2 hours\tmelete-sbx-theirs-sbx_c\t"theirs"\t""',
  ];
  const attempts = (
    env: Record<string, string> = { MELETE_SANDBOX_PROJECT: 'melete-1a2b3c4d' },
  ) => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, env);
    return testContext(deployDir, [
      [
        'docker ps --all --filter label=com.melete.project=melete --filter label=com.melete.attempt',
        { code: 0, stdout: `melete-${ATTEMPT}\tExited (0) 2 minutes ago\t${ATTEMPT}\n` },
      ],
      [
        'docker ps --all --filter label=com.melete.sandbox --format ',
        { code: 0, stdout: `${COMPUTERS.join('\n')}\n` },
      ],
    ]);
  };

  test("--computers lists this installation's computers, those of an earlier sandbox project too, and no other's", async () => {
    const context = attempts();
    expect(await runLogs(context, ['--computers'])).toBe(0);
    const printed = context.printed();
    expect(printed).toContain('melete-sbx-desk\tUp 3 hours');
    expect(printed).toContain('melete-sbx-old-sbx_a\tExited (0) 1 day ago');
    expect(printed).not.toContain('sbx_b');
    expect(printed).not.toContain('sbx_c');
    expect(await runLogs(context, ['--computers', 'sbx_b'])).toBe(2);

    // Without a sandbox project, those that name this installation are still its own.
    const blank = attempts({ MELETE_SANDBOX_PROJECT: '' });
    expect(await runLogs(blank, ['--computers'])).toBe(0);
    expect(blank.printed()).toContain('melete-sbx-old-sbx_a');
    expect(blank.printed()).not.toContain('melete-sbx-desk');
  });

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

  test("--computers finds a computer by its name among this installation's", async () => {
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

  test('Ctrl-C says which command it stopped and what may have changed', () => {
    const stopped = (command: string, signal: 'SIGINT' | 'SIGTERM', hint?: string) => {
      const written: string[] = [];
      const codes: number[] = [];
      const handler = interruption(
        command,
        (text) => written.push(text),
        (code) => codes.push(code),
      );
      if (hint !== undefined) handler.hint(hint);
      handler.handle(signal);
      return { text: written.join(''), codes };
    };
    // A restore's own hint, which it registers while its steps run.
    const restore = stopped(
      'restore',
      'SIGINT',
      'Running the same restore --yes again is safe: it starts over from the backup.',
    );
    expect(restore.codes).toEqual([130]);
    expect(restore.text).toBe(
      '\nCtrl-C stopped melete restore. Running the same restore --yes again is safe: it starts over from the backup.\n',
    );
    // Without one, the line still names the command and what may have changed.
    const backup = stopped('backup', 'SIGTERM');
    expect(backup.codes).toEqual([143]);
    expect(backup.text).toMatch(/^\nSIGTERM stopped melete backup\. .+\n$/);
    expect(stopped('status', 'SIGINT').text).toBe(
      '\nCtrl-C stopped melete status. It changes nothing.\n',
    );
  });

  test("a directory that is not a checkout's deploy directory is refused", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'melete-not-deploy-'));
    const context = testContext(elsewhere);
    expect(await main(['check', '--deploy-dir', elsewhere], () => context)).toBe(2);
    expect(context.errors()).toContain("is not a checkout's deploy directory");
  });
});
