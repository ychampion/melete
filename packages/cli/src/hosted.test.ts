import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { judgeCheck } from './commands/check.ts';
import { runStatus } from './commands/status.ts';
import { DEPLOY_FILE, deployConfigSchema, renderDeployConfig } from './deploy-config.ts';
import { judgeHosted } from './hosted.ts';
import { readInstallation } from './installation.ts';
import { temporaryDeployDir, testContext, writeEnv } from './testing.ts';

const READY = {
  MELETE_PUBLIC_URL: 'https://assistant.example.net',
  MELETE_WEB_ORIGIN: 'https://assistant.example.net',
  MELETE_ALERT_WEBHOOK_URL: 'https://hooks.example.net/melete',
  MELETE_OPERATOR_TOKEN: 'o'.repeat(48),
};
const config = (hosted?: boolean) =>
  deployConfigSchema.parse({ contract: 1, ...(hosted === undefined ? {} : { hosted }) });
const levels = (results: ReturnType<typeof judgeHosted>) =>
  Object.fromEntries(results.map((result) => [result.id, result.level]));

describe('what an installation for other people needs', () => {
  test('a hosted installation with everything set passes', () => {
    expect(levels(judgeHosted(config(true), READY))).toEqual({
      'hosted.public_url': 'ok',
      'hosted.web_origin': 'ok',
      'hosted.alerts': 'ok',
      'hosted.operator_token': 'ok',
    });
  });

  test('a hosted installation fails each missing piece by name', () => {
    expect(levels(judgeHosted(config(true), {}))).toEqual({
      'hosted.public_url': 'fail',
      'hosted.alerts': 'fail',
      'hosted.operator_token': 'fail',
    });
    const plainHttp = judgeHosted(config(true), {
      ...READY,
      MELETE_PUBLIC_URL: 'http://assistant.example.net',
    });
    expect(levels(plainHttp)['hosted.public_url']).toBe('fail');
  });

  test('a web origin that differs from the public address fails, with the fix', () => {
    const results = judgeHosted(config(true), {
      ...READY,
      MELETE_WEB_ORIGIN: 'https://old.example.net',
    });
    const origin = results.find((result) => result.id === 'hosted.web_origin');
    expect(origin?.level).toBe('fail');
    expect(origin?.fix).toContain('MELETE_WEB_ORIGIN=https://assistant.example.net');
  });

  test('an installation not marked hosted only warns, and says how to require them', () => {
    const results = judgeHosted(config(), {});
    expect(results.every((result) => result.level === 'warn')).toBe(true);
    expect(results[0]?.detail).toContain('"hosted": true');
  });

  test('the key is optional: a file without it reads, and one with it keeps it', () => {
    expect(renderDeployConfig(config())).not.toContain('hosted');
    expect(JSON.parse(renderDeployConfig(config(true))).hosted).toBe(true);
  });
});

describe('check and status judge it', () => {
  const hostedInstall = (env: Record<string, string>) => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, env);
    writeFileSync(
      join(deployDir, DEPLOY_FILE),
      JSON.stringify({
        contract: 1,
        hosted: true,
        images: { registry: 'ghcr.io/ychampion', tag: 'main', channel: 'main' },
      }),
    );
    return deployDir;
  };

  test('check fails a hosted installation without its public address', () => {
    const failed = judgeCheck(readInstallation(hostedInstall({}), 'linux'))
      .filter((result) => result.level === 'fail')
      .map((result) => result.id);
    expect(failed).toEqual(
      expect.arrayContaining(['hosted.public_url', 'hosted.alerts', 'hosted.operator_token']),
    );
    const ready = judgeCheck(readInstallation(hostedInstall(READY), 'linux'));
    expect(ready.filter((result) => result.id.startsWith('hosted.')).map((r) => r.level)).toEqual([
      'ok',
      'ok',
      'ok',
      'ok',
    ]);
  });

  test('status reports the same rules', async () => {
    const context = testContext(hostedInstall({}));
    await runStatus(context, true);
    const report = JSON.parse(context.printed()) as { results: { id: string; level: string }[] };
    expect(report.results.find((result) => result.id === 'hosted.public_url')?.level).toBe('fail');
  });
});
