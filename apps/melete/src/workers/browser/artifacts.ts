import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { JsonObject, JsonValue } from '@melete/contracts';
import type { Sql } from 'postgres';
import { recordId } from '../../broker/records.ts';

export type BrowserObservation = {
  id: string;
  url: string;
  tree: string;
  /** Empty when the worker withheld the picture, as after a person hands back control. */
  screenshot: string;
  schema: JsonValue;
};

export type BrowserArtifactSink = (
  scope: { space_id: string; job_id: string },
  observation: BrowserObservation,
) => Promise<JsonObject>;

/** Artifacts use service-chosen paths; a worker can provide bytes but never a destination. */
export function browserArtifactSink(sql: Sql, spacesRoot: string): BrowserArtifactSink {
  return async (scope, observation) => {
    if (!/^sp_[A-Za-z0-9_-]+$/.test(scope.space_id)) throw new Error('invalid artifact space');
    const base = resolve(spacesRoot);
    await mkdir(base, { recursive: true });
    let ancestor = base;
    for (;;) {
      if ((await lstat(ancestor)).isSymbolicLink()) throw new Error('artifact root is a link');
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    let directory = await realpath(base);
    for (const segment of [scope.space_id, 'artifacts', 'browser']) {
      directory = join(directory, segment);
      await mkdir(directory, { recursive: true });
      if ((await lstat(directory)).isSymbolicLink() || (await realpath(directory)) !== directory)
        throw new Error('artifact directory is outside its space');
    }
    const contents = [
      { key: 'tree', mime: 'text/plain', extension: 'txt', bytes: Buffer.from(observation.tree) },
      ...(observation.screenshot
        ? [
            {
              key: 'screenshot',
              mime: 'image/png',
              extension: 'png',
              bytes: Buffer.from(observation.screenshot, 'base64'),
            },
          ]
        : []),
    ];
    if (contents.some((item) => item.bytes.byteLength > 4 * 1024 * 1024))
      throw new Error('browser observation exceeds artifact limit');
    const handles: JsonObject = {};
    for (const item of contents) {
      const id = recordId('art');
      const relativePath = `browser/${id}.${item.extension}`;
      const target = join(directory, `${id}.${item.extension}`);
      const file = await open(
        target,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        await file.writeFile(item.bytes);
      } finally {
        await file.close();
      }
      const hash = createHash('sha256').update(item.bytes).digest('hex');
      await sql`insert into artifact (id, space_id, job_id, path, content_hash, mime, size)
        values (${id}, ${scope.space_id}, ${scope.job_id}, ${relativePath}, ${hash}, ${item.mime}, ${item.bytes.byteLength})`;
      handles[item.key] = {
        artifact_id: id,
        path: relativePath,
        area: 'artifacts',
        mime: item.mime,
        content_hash: hash,
      };
    }
    return {
      id: observation.id,
      url: observation.url,
      schema: observation.schema,
      ...handles,
    };
  };
}
