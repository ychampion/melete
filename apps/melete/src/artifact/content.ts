import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { noLinks, openBeneath, segmentsFor } from '../connectors/files.ts';

export type ArtifactRoots = { workRoot: string; spacesRoot: string };
export const defaultArtifactRoots = (): ArtifactRoots => ({
  workRoot: process.env.MELETE_WORK_DIR ?? '/work',
  spacesRoot: process.env.MELETE_SPACES_DIR ?? '/data/spaces',
});

/** Re-read current bytes through the same path boundary as the files connector. */
export async function readArtifactContent(
  roots: ArtifactRoots,
  location: { jobId: string; spaceId: string; area: string; path: string },
): Promise<{ bytes: Buffer; hash: string }> {
  if (!/^job_[A-Za-z0-9]+$/.test(location.jobId) || !/^sp_[A-Za-z0-9]+$/.test(location.spaceId))
    throw new Error('invalid artifact scope');
  if (!['work', 'artifacts'].includes(location.area)) throw new Error('invalid artifact area');
  const base = await realpath(location.area === 'work' ? roots.workRoot : roots.spacesRoot);
  const scope = location.area === 'work' ? [location.jobId] : [location.spaceId, 'artifacts'];
  const segments = [...scope, ...segmentsFor(location.path)];
  await noLinks(base, segments, false);
  const file = await openBeneath(base, segments, constants.O_RDONLY);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024)
      throw new Error('artifact exceeds validation read limit');
    const bytes = await file.readFile();
    return { bytes, hash: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    await file.close();
  }
}
