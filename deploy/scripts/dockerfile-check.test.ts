import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  checkDockerfileWorkspaces,
  installingDockerfiles,
  missingWorkspaceManifests,
  workspaceDirectories,
} from './dockerfile-check.ts';

const root = join(import.meta.dir, '..', '..');

describe('the shipped Dockerfiles', () => {
  test('the root manifest declares the evaluation workspace', () => {
    expect(workspaceDirectories(root)).toContain('evals');
  });

  test('both images that install dependencies are checked', () => {
    expect(installingDockerfiles(root)).toEqual(
      expect.arrayContaining(['deploy/Dockerfile.melete', 'deploy/Dockerfile.web']),
    );
  });

  test('copy every workspace manifest before a frozen install', () => {
    expect(
      checkDockerfileWorkspaces(root)
        .filter((result) => !result.ok)
        .map((result) => `${result.name}: ${result.detail}`),
    ).toEqual([]);
  });
});

describe('the check catches the mistakes that would break a build', () => {
  const workspaces = ['apps/melete', 'evals', 'packages/contracts'];

  test('a workspace manifest that is never copied', () => {
    const dockerfile = [
      'FROM oven/bun:1',
      'COPY package.json bun.lock ./',
      'COPY apps/melete/package.json apps/melete/',
      'COPY packages/contracts/package.json packages/contracts/',
      'RUN bun install --frozen-lockfile',
    ].join('\n');
    expect(missingWorkspaceManifests(dockerfile, workspaces)).toEqual(['evals/package.json']);
  });

  test('a manifest copied only after the install', () => {
    const dockerfile = [
      'FROM oven/bun:1',
      'COPY apps/melete/package.json apps/melete/',
      'COPY packages/contracts/package.json packages/contracts/',
      'RUN bun install --frozen-lockfile --production',
      'COPY evals/package.json evals/',
    ].join('\n');
    expect(missingWorkspaceManifests(dockerfile, workspaces)).toEqual(['evals/package.json']);
  });

  test('a manifest copied in an earlier stage or from another image', () => {
    const dockerfile = [
      'FROM oven/bun:1 AS manifests',
      'COPY evals/package.json evals/',
      'FROM oven/bun:1',
      'COPY --from=manifests /app/evals/package.json evals/',
      'COPY apps/ apps/',
      'COPY packages/contracts/package.json packages/contracts/',
      'RUN apt-get update \\',
      '    && bun install --frozen-lockfile',
    ].join('\n');
    expect(missingWorkspaceManifests(dockerfile, workspaces)).toEqual(['evals/package.json']);
  });

  test('directory and whole-context copies cover the manifests inside them', () => {
    const dockerfile = [
      'FROM oven/bun:1',
      '# COPY evals/package.json evals/ is not an instruction',
      'COPY --chown=1000:1000 apps/ packages/ ./',
      'COPY ./evals/package.json evals/',
      'RUN bun install --frozen-lockfile',
      'FROM oven/bun:1',
      'COPY . .',
      'RUN bun install',
    ].join('\n');
    expect(missingWorkspaceManifests(dockerfile, workspaces)).toEqual([]);
  });
});
