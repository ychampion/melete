import { describe, expect, test } from 'bun:test';
import { judgeStatus, type StatusFacts } from '../../../deploy/scripts/status.ts';
import { asResult, diskFloors, statusComposeArgs } from './commands/status.ts';
import { deployConfigSchema } from './deploy-config.ts';

const GB = 1024 ** 3;

const facts: StatusFacts = {
  docker: [],
  dockerVersions: 'Engine 28.3.0, Compose 2.39.1',
  env: {
    COMPOSE_PROJECT_NAME: 'melete',
    MELETE_DEFAULT_PROVIDER: 'anthropic',
    MELETE_DEFAULT_MODEL: 'a-model',
    ANTHROPIC_API_KEY: 'sk-test-value',
    MELETE_IMAGE_TAG: 'main',
  },
  freeBytes: 1.5 * GB,
  images: [{ name: 'ghcr.io/ychampion/melete-service:main', present: true }],
  services: ['postgres', 'melete', 'runtime', 'web'].map((service) => ({
    service,
    state: 'running',
    health: 'healthy',
  })),
  health: { status: 'ok', database: 'ok' },
  setupNeeded: false,
};

const config = (min_free_mb: number) =>
  deployConfigSchema.parse({ contract: 1, disk: { min_free_mb, pull_margin_mb: 200 } });
const disk = (min_free_mb: number) =>
  judgeStatus(facts, diskFloors(config(min_free_mb))).find((check) => check.name === 'Disk');

describe('melete status', () => {
  test('a host with its own floor below 4 GB is ready above that floor', () => {
    expect(disk(600)).toMatchObject({ level: 'warn' });
    expect(disk(4096)).toMatchObject({ level: 'fail' });
  });

  test('below its own floor it fails and names the floor', () => {
    expect(disk(2048)).toMatchObject({
      level: 'fail',
      detail:
        '1.5 GB free where Docker keeps its images; this installation keeps at least 2048 MB free.',
    });
  });

  test("the contract's overlays and profiles reach Compose", () => {
    const args = statusComposeArgs(
      '/srv/melete/deploy',
      deployConfigSchema.parse({ contract: 1, overlays: ['browser'], profiles: ['sandbox'] }),
    );
    expect(args.join(' ')).toMatch(/^-f .*docker-compose\.browser\.yml --profile sandbox$/);
  });

  test('each status line becomes a rule id', () => {
    expect(
      asResult({ level: 'ok', name: 'Public address', detail: 'None set (optional).' }),
    ).toEqual({
      id: 'status.public_address',
      level: 'ok',
      detail: 'None set (optional).',
    });
  });
});
