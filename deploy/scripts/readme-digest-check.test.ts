import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  checkReadmeDigests,
  compareDigests,
  composeFiles,
  pinnedImages,
  quotedImages,
  removalSection,
} from './readme-digest-check.ts';

const root = join(import.meta.dir, '..', '..');
const PINNED = 'a'.repeat(64);
const BUMPED = 'b'.repeat(64);

const compose = (image: string) => [
  {
    file: 'deploy/docker-compose.yml',
    text: `services:\n  postgres:\n    image: ${image}\n  web:\n    image: melete-web:local\n  browser:\n    build:\n      context: ..\n`,
  },
];

const readme = (commands: string) =>
  [
    '## Run it yourself',
    '',
    '### Remove it completely',
    '',
    '```bash',
    '# A shell comment is not a heading.',
    commands,
    '```',
    '',
    '## Everything else it does',
    '',
    `postgres@sha256:${'c'.repeat(64)} sits outside the section.`,
  ].join('\n');

describe('the repository', () => {
  test('README removes every pulled image at the digest the Compose files pin', () => {
    const results = checkReadmeDigests(root);
    expect(results.filter((result) => !result.ok)).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  test('the Compose files it reads include the base file and the Tailscale override', () => {
    const files = composeFiles(root).map((entry) => entry.file);
    expect(files).toContain('deploy/docker-compose.yml');
    expect(files).toContain('deploy/docker-compose.tailscale.yml');
  });
});

describe('reading the pins', () => {
  test('a tagged or bare digest pin counts; a local tag or a build does not', () => {
    expect(pinnedImages(compose(`postgres:17-alpine@sha256:${PINNED}`))).toEqual([
      {
        repository: 'postgres',
        digest: PINNED,
        source: 'deploy/docker-compose.yml service postgres',
      },
    ]);
    expect(pinnedImages(compose(`tailscale/tailscale@sha256:${PINNED}`))[0]?.repository).toBe(
      'tailscale/tailscale',
    );
    expect(pinnedImages(compose('postgres:17-alpine'))).toEqual([]);
  });

  test('the section ends at the next heading, not at a shell comment', () => {
    const section = removalSection(readme(`docker image rm postgres@sha256:${PINNED}`));
    expect(quotedImages(section ?? '')).toEqual([{ repository: 'postgres', digest: PINNED }]);
  });
});

describe('comparing them', () => {
  const pins = pinnedImages(compose(`postgres:17-alpine@sha256:${PINNED}`));

  test('the quoted digest matches the pin', () => {
    const results = compareDigests(
      pins,
      removalSection(readme(`docker image rm postgres@sha256:${PINNED}`)),
    );
    expect(results.map((result) => result.ok)).toEqual([true]);
  });

  test('a pin bumped in Compose and not in README fails twice, naming both digests', () => {
    const bumped = pinnedImages(compose(`postgres:17-alpine@sha256:${BUMPED}`));
    const results = compareDigests(
      bumped,
      removalSection(readme(`docker image rm postgres@sha256:${PINNED}`)),
    );
    expect(results.map((result) => result.ok)).toEqual([false, false]);
    expect(results[0]?.detail).toContain(`postgres@sha256:${BUMPED}`);
    expect(results[0]?.detail).toContain(`quoted: ${PINNED}`);
    expect(results[1]?.detail).toContain(`postgres@sha256:${PINNED} is pinned by no`);
  });

  test('a pinned image README does not mention fails', () => {
    const results = compareDigests(
      pins,
      removalSection(readme('docker image rm melete-web:local')),
    );
    expect(results.map((result) => result.ok)).toEqual([false]);
    expect(results[0]?.detail).toContain('quoted: nothing');
  });

  test('a README digest for an image no Compose file pins fails', () => {
    const results = compareDigests(
      pins,
      removalSection(readme(`docker image rm postgres@sha256:${PINNED} redis@sha256:${BUMPED}`)),
    );
    expect(results.map((result) => result.ok)).toEqual([true, false]);
    expect(results[1]?.detail).toContain(`redis@sha256:${BUMPED}`);
  });

  test('a README that lost the section fails rather than passing on nothing', () => {
    const results = compareDigests(pins, removalSection('# Melete\n'));
    expect(results.map((result) => result.ok)).toEqual([false]);
    expect(results[0]?.detail).toContain('Remove it completely');
  });
});
