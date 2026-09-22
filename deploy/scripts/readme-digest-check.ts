/**
 * README's "Remove it completely" section tells the last installation on a host
 * to remove the images Docker pulled, by digest, because a pull by
 * `name:tag@digest` need not leave the tag behind. Those digests are copied from
 * the Compose files, so a pin bump that left README behind would hand the
 * reader a command that removes nothing. This compares the two without Docker.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { ComposeFile } from './compose-check.ts';
import type { CheckResult } from './plugin-pin-check.ts';

/** An image pinned by digest: its repository without the tag, and the digest. */
export type PinnedImage = { repository: string; digest: string; source: string };

export const README = 'README.md';
export const REMOVAL_HEADING = '### Remove it completely';

const DIGEST_REFERENCE = /^([^@\s]+?)(?::[^@/\s]+)?@sha256:([0-9a-f]{64})$/;
const QUOTED_REFERENCE = /([a-z0-9][a-z0-9._/-]*)@sha256:([0-9a-f]{64})/g;

/** Every service image in the given Compose files that is pinned by digest. */
export function pinnedImages(files: { file: string; text: string }[]): PinnedImage[] {
  const pins: PinnedImage[] = [];
  for (const { file, text } of files) {
    const compose = (parse(text) ?? {}) as ComposeFile;
    for (const [service, definition] of Object.entries(compose.services ?? {})) {
      const match = DIGEST_REFERENCE.exec(definition?.image ?? '');
      if (match)
        pins.push({
          repository: match[1] as string,
          digest: match[2] as string,
          source: `${file} service ${service}`,
        });
    }
  }
  return pins;
}

/**
 * The removal section of README, from its heading to the next heading of its
 * rank or above. A `#` inside a fenced block is a shell comment, not a heading.
 */
export function removalSection(readme: string): string | undefined {
  const lines = readme.split('\n');
  const start = lines.findIndex((line) => line.trim() === REMOVAL_HEADING);
  if (start === -1) return undefined;
  let fenced = false;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && /^#{1,3}\s/.test(line)) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** Every `repository@sha256:digest` reference in a piece of text. */
export function quotedImages(text: string): { repository: string; digest: string }[] {
  return [...text.matchAll(QUOTED_REFERENCE)].map((match) => ({
    repository: match[1] as string,
    digest: match[2] as string,
  }));
}

/**
 * One result per pinned image, which README must quote at exactly that digest,
 * and one per README reference that no Compose file pins, which is what a pin
 * bump leaves behind.
 */
export function compareDigests(
  pins: PinnedImage[],
  section: string | undefined,
  readme = README,
): CheckResult[] {
  if (section === undefined)
    return [
      {
        name: `${readme} has the section that removes pulled images by digest`,
        ok: false,
        detail: `no "${REMOVAL_HEADING}" heading`,
      },
    ];
  const quoted = quotedImages(section);
  const results: CheckResult[] = pins.map((pin) => {
    const seen = quoted.filter((reference) => reference.repository === pin.repository);
    return {
      name: `${readme} removes ${pin.repository} at the digest ${pin.source} pins`,
      ok: seen.some((reference) => reference.digest === pin.digest),
      detail: `quote ${pin.repository}@sha256:${pin.digest} (quoted: ${
        seen.map((reference) => reference.digest).join(', ') || 'nothing'
      })`,
    };
  });
  for (const reference of quoted)
    if (
      !pins.some(
        (pin) => pin.repository === reference.repository && pin.digest === reference.digest,
      )
    )
      results.push({
        name: `${readme} quotes only digests the Compose files pin`,
        ok: false,
        detail: `${reference.repository}@sha256:${reference.digest} is pinned by no deploy/docker-compose*.yml`,
      });
  return results;
}

/** The Compose files under deploy/, each with its text. */
export function composeFiles(root: string): { file: string; text: string }[] {
  return readdirSync(join(root, 'deploy'))
    .filter((name) => /^docker-compose.*\.ya?ml$/.test(name))
    .sort()
    .map((name) => ({
      file: `deploy/${name}`,
      text: readFileSync(join(root, 'deploy', name), 'utf8'),
    }));
}

/** Whether README's removal commands still name the images the Compose files pull. */
export function checkReadmeDigests(root: string): CheckResult[] {
  return compareDigests(
    pinnedImages(composeFiles(root)),
    removalSection(readFileSync(join(root, README), 'utf8')),
  );
}
