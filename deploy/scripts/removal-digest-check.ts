/**
 * The "Remove it completely" section of docs/DEPLOYMENT.md tells the last
 * installation on a host to remove the images Docker pulled, by digest, because
 * a pull by `name:tag@digest` need not leave the tag behind. Those digests are
 * copied from the Compose files, so a pin bump that left the section behind
 * would hand the reader a command that removes nothing. This compares the two
 * without Docker.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { ComposeFile } from './compose-check.ts';
import type { CheckResult } from './plugin-pin-check.ts';

/** An image pinned by digest: its repository without the tag, and the digest. */
export type PinnedImage = { repository: string; digest: string; source: string };

export const REMOVAL_DOCUMENT = 'docs/DEPLOYMENT.md';
export const REMOVAL_HEADING = '## Remove it completely';

/**
 * `repository[:tag]@sha256:digest`. A tag cannot hold a `/`, so the port in
 * `localhost:5000/pg@sha256:…` stays part of the repository.
 */
const DIGEST_REFERENCE = /^([^@\s]+?)(?::[^@/\s]+)?@sha256:([0-9a-f]{64})$/;

/** A service image that mentions a digest but does not read as a reference. */
export type UnreadablePin = { image: string; source: string };

/**
 * Every service image in the given Compose files that is pinned by digest, and
 * every one that mentions `@sha256` without reading as `repository[:tag]@sha256:
 * digest`, such as a `${VARIABLE}` Compose would interpolate: this check cannot
 * know what that becomes, so it is reported rather than passed over. Merge keys
 * are read as Compose reads them, so an image a service inherits through
 * `<<: *anchor` is seen as that service's own.
 */
export function pinnedImages(files: { file: string; text: string }[]): {
  pins: PinnedImage[];
  unreadable: UnreadablePin[];
} {
  const pins: PinnedImage[] = [];
  const unreadable: UnreadablePin[] = [];
  for (const { file, text } of files) {
    const compose = (parse(text, { merge: true }) ?? {}) as ComposeFile;
    for (const [service, definition] of Object.entries(compose.services ?? {})) {
      const image = definition?.image ?? '';
      const source = `${file} service ${service}`;
      const match = DIGEST_REFERENCE.exec(image);
      if (match) pins.push({ repository: match[1] as string, digest: match[2] as string, source });
      else if (image.includes('@sha256')) unreadable.push({ image, source });
    }
  }
  return { pins, unreadable };
}

/** One failure for each Compose image whose digest pin the check cannot read. */
export function unreadablePins(unreadable: UnreadablePin[]): CheckResult[] {
  return unreadable.map(({ image, source }) => ({
    name: `${source} pins its image in a form the removal check can read`,
    ok: false,
    detail: `${image} is not repository[:tag]@sha256:<64 lower-case hex digits>`,
  }));
}

/** The section's text, and whether a code fence opened in it never closes. */
export type Section = { text: string; unclosedFence: boolean };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)\s*$/;

/**
 * The removal section, from its heading to the next heading of its rank or
 * above, read as Markdown reads it: a subsection of lower rank stays inside, an
 * underlined heading (always rank one or two) ends it. A fence closes only on the marker
 * that opened it, at least as long, so a `~~~` line inside a backtick block is
 * content; a `#` inside a fence is a shell comment, not a heading. Outside a
 * fence, an `=` or `-` line under a paragraph line makes that line a heading,
 * which ends the section. A fence still open at the end of the file swallows
 * everything after it, so it is reported rather than read.
 */
export function removalSection(document: string): Section | undefined {
  const lines = document.split('\n');
  const start = lines.findIndex((line) => line.trim() === REMOVAL_HEADING);
  if (start === -1) return undefined;
  const rank = REMOVAL_HEADING.indexOf(' ');
  const sameRankOrAbove = new RegExp(`^ {0,3}#{1,${rank}}(?:\\s|$)`);
  let fence: string | undefined;
  let paragraph = false;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const marker = FENCE.exec(line)?.[1];
    if (fence !== undefined) {
      if (
        marker !== undefined &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        line.trim() === marker
      )
        fence = undefined;
      continue;
    }
    if (marker !== undefined) {
      fence = marker;
      paragraph = false;
      continue;
    }
    if (sameRankOrAbove.test(line)) {
      end = index;
      break;
    }
    if (paragraph && SETEXT_UNDERLINE.test(line)) {
      end = index - 1;
      break;
    }
    paragraph = line.trim() !== '';
  }
  return {
    text: lines.slice(start, end).join('\n'),
    unclosedFence: fence !== undefined,
  };
}

/**
 * Every digest reference in a piece of text, read one whitespace-separated
 * token at a time with the pattern the Compose pins are read with, so a tagged
 * or registry-qualified reference names its whole repository. Markdown and
 * shell punctuation around a token is dropped first. A token that mentions
 * `@sha256` and still does not read as a reference is returned as unreadable.
 */
export function quotedImages(text: string): {
  references: { repository: string; digest: string }[];
  unreadable: string[];
} {
  const references: { repository: string; digest: string }[] = [];
  const unreadable: string[] = [];
  for (const token of text.split(/\s+/)) {
    if (!token.includes('@sha256')) continue;
    const bare = token.replace(/^[^A-Za-z0-9]+/, '').replace(/[^0-9a-f]+$/, '');
    const match = DIGEST_REFERENCE.exec(bare);
    if (match) references.push({ repository: match[1] as string, digest: match[2] as string });
    else unreadable.push(token);
  }
  return { references, unreadable };
}

/**
 * One result per pinned image, which the section must quote at exactly that
 * digest, and one per reference in it that no Compose file pins, which is what
 * a pin bump leaves behind.
 */
export function compareDigests(
  pins: PinnedImage[],
  section: Section | undefined,
  document = REMOVAL_DOCUMENT,
): CheckResult[] {
  if (section === undefined)
    return [
      {
        name: `${document} has the section that removes pulled images by digest`,
        ok: false,
        detail: `no "${REMOVAL_HEADING}" heading`,
      },
    ];
  if (section.unclosedFence)
    return [
      {
        name: `${document} closes every code fence in the section that removes pulled images`,
        ok: false,
        detail: `a fence opened after "${REMOVAL_HEADING}" never closes, so the rest of the file reads as code`,
      },
    ];
  const { references: quoted, unreadable } = quotedImages(section.text);
  const results: CheckResult[] = pins.map((pin) => {
    const seen = quoted.filter((reference) => reference.repository === pin.repository);
    return {
      name: `${document} quotes ${pin.repository} at the digest ${pin.source} pins`,
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
        name: `${document} quotes only digests the Compose files pin`,
        ok: false,
        detail: `${reference.repository}@sha256:${reference.digest} is pinned by no deploy/docker-compose*.yml`,
      });
  for (const token of unreadable)
    results.push({
      name: `${document} quotes only digest references the check can read`,
      ok: false,
      detail: `${token} is not repository[:tag]@sha256:<64 lower-case hex digits>`,
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

/** Whether the removal commands still name the images the Compose files pull. */
export function checkRemovalDigests(root: string): CheckResult[] {
  const { pins, unreadable } = pinnedImages(composeFiles(root));
  return [
    ...unreadablePins(unreadable),
    ...compareDigests(pins, removalSection(readFileSync(join(root, REMOVAL_DOCUMENT), 'utf8'))),
  ];
}
