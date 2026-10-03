import { describe, expect, test } from 'bun:test';
import { composeCommand, defaultDeployConfig, parseDeployConfig } from './deploy-config.ts';

const valid = (text: string) => {
  const loaded = parseDeployConfig(text);
  if (loaded.kind !== 'found') throw new Error(JSON.stringify(loaded));
  return loaded.config;
};

const issues = (text: string) => {
  const loaded = parseDeployConfig(text);
  return loaded.kind === 'invalid' ? loaded.issues.join('\n') : '';
};

describe('the deploy contract', () => {
  test('a file with only the contract number takes every default', () => {
    expect(valid('{"contract":1}')).toEqual(defaultDeployConfig());
    expect(defaultDeployConfig()).toMatchObject({
      project: 'melete',
      images: { registry: 'ghcr.io/ychampion', tag: 'main', channel: 'main' },
      disk: { min_free_mb: 4096, pull_margin_mb: 512 },
      public_ports: false,
    });
  });

  test('a floor below 1 GB is expressible in MB', () => {
    expect(valid('{"contract":1,"disk":{"min_free_mb":600,"pull_margin_mb":200}}').disk).toEqual({
      min_free_mb: 600,
      pull_margin_mb: 200,
    });
  });

  test('a contract this release does not know is refused rather than guessed at', () => {
    expect(issues('{"contract":2}')).toContain('this release reads contract 1');
  });

  test('a misspelt key is refused, so a floor never falls back to its default unnoticed', () => {
    expect(issues('{"contract":1,"disk":{"min_free_gb":1}}')).toContain('disk');
    expect(issues('{"contract":1,"publicPorts":true}')).not.toBe('');
  });

  test('images built here carry no registry, and published images carry one', () => {
    expect(
      valid('{"contract":1,"images":{"registry":null,"tag":"local","channel":"local"}}').images
        .registry,
    ).toBeNull();
    expect(issues('{"contract":1,"images":{"registry":null,"tag":"main"}}')).toContain('images');
    expect(issues('{"contract":1,"images":{"tag":"local"}}')).toContain('images');
  });

  test('the kernel Tailscale overlay is read on top of the ordinary one', () => {
    expect(issues('{"contract":1,"overlays":["tailscale-kernel"]}')).toContain('tailscale');
    const config = valid(
      '{"contract":1,"overlays":["tailscale-kernel","tailscale"],"profiles":["sandbox"]}',
    );
    const command = composeCommand('/srv/melete/deploy', config).join(' ');
    // Compose reads files in order: the base, then tailscale, then the kernel variant.
    expect(command).toMatch(
      /docker-compose\.yml -f .*docker-compose\.tailscale\.yml -f .*docker-compose\.tailscale-kernel\.yml --profile sandbox$/,
    );
  });

  test('text that is not JSON is named as such', () => {
    expect(issues('{contract:1}')).toContain('is not JSON');
  });
});
