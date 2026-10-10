import { describe, expect, test } from 'bun:test';
import {
  ACCOUNT_SCRIPT,
  accountArguments,
  feedbackArguments,
  runAccount,
  webUrlOf,
} from './commands/account.ts';
import { main } from './main.ts';
import { temporaryDeployDir, testContext, writeEnv } from './testing.ts';

describe('melete account: arguments', () => {
  test('each command takes what it needs, and nothing else', () => {
    expect(accountArguments(['list'])).toEqual(['list']);
    expect(accountArguments(['setup-code'])).toEqual(['setup-code']);
    expect(accountArguments(['create', 'sam@example.com'])).toEqual(['create', 'sam@example.com']);
    for (const command of ['reset', 'disable', 'enable'])
      expect(accountArguments([command, 'sam@example.com'])).toEqual([command, 'sam@example.com']);
    for (const refused of [
      [],
      ['list', 'extra'],
      ['create'],
      ['create', 'not-an-address'],
      ['reset', 'a@example.com', 'b@example.com'],
      ['drop', 'a@example.com'],
    ])
      expect(typeof accountArguments(refused)).toBe('string');
  });

  test('feedback lists, filters and shows one report', () => {
    expect(feedbackArguments([])).toEqual([]);
    expect(feedbackArguments(['list', '--all'])).toEqual(['list', '--all']);
    expect(feedbackArguments(['--status', 'open'])).toEqual(['--status', 'open']);
    expect(feedbackArguments(['show', 'FB-7Q2X'])).toEqual(['show', 'FB-7Q2X']);
    expect(typeof feedbackArguments(['show', 'x; rm -rf /'])).toBe('string');
    expect(typeof feedbackArguments(['--status', 'whatever'])).toBe('string');
  });

  test('links point at the public address, or at the web port on this machine', () => {
    expect(webUrlOf({ MELETE_PUBLIC_URL: 'https://melete.example.com' })).toBe(
      'https://melete.example.com',
    );
    expect(webUrlOf({ WEB_PORT: '4101' })).toBe('http://127.0.0.1:4101');
    expect(webUrlOf(null)).toBe('http://127.0.0.1:3101');
  });
});

describe('melete account: running', () => {
  test('runs in the service container, with the link address and --json passed on', async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, { MELETE_PUBLIC_URL: 'https://melete.example.com' });
    const context = testContext(deployDir);
    expect(await runAccount(context, ['reset', 'sam@example.com'], true)).toBe(0);
    const command = context.attached[0] ?? [];
    expect(command).toContain('exec');
    expect(command.slice(command.indexOf('exec'))).toEqual([
      'exec',
      '-T',
      'melete',
      'bun',
      'run',
      ACCOUNT_SCRIPT,
      'reset',
      'sam@example.com',
      '--web-url',
      'https://melete.example.com',
      '--json',
    ]);
  });

  test('a mistyped command is refused before anything runs', async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    const context = testContext(deployDir);
    expect(await runAccount(context, ['create'], false)).not.toBe(0);
    expect(context.attached).toHaveLength(0);
    expect(context.errors()).toContain('takes an email address');
  });

  test('is a command main knows', async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    const context = testContext(deployDir);
    expect(await main(['account', 'list', '--deploy-dir', deployDir], () => context)).toBe(0);
    expect(context.attached.at(-1)?.includes(ACCOUNT_SCRIPT)).toBe(true);
  });
});
