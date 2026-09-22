import { join } from 'node:path';
import type { ExtractionProposal } from '@melete/contracts';
import type { CommitResult } from '../../src/memory/commit.ts';
import type { MemoryScope } from '../../src/memory/db.ts';
import type { ExtractionBatch } from '../../src/memory/work.ts';
import type { TestDatabase } from './postgres.ts';

export type FaultPhase =
  | 'after-input'
  | 'after-claim'
  | 'after-proposal'
  | 'before-publication'
  | 'after-publication'
  | 'during-cleanup';
type FaultCheckpoint = {
  ready: FaultPhase;
  batch?: ExtractionBatch;
  proposals?: ExtractionProposal[];
  result?: CommitResult;
};
/** A real OS kill leaves the parent Postgres server running, including committed outbox rows. */
export async function killAt(
  db: TestDatabase,
  scope: MemoryScope,
  phase: FaultPhase,
): Promise<FaultCheckpoint> {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'fault-worker.ts'), phase, scope.spaceId],
    {
      env: { ...process.env, MELETE_FAULT_DATABASE_URL: db.url },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    },
  );
  const errors = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const checkpoint = await Promise.race([
      (async () => {
        let buffer = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`fault child exited: ${await errors}`);
          buffer += new TextDecoder().decode(value);
          const newline = buffer.indexOf('\n');
          if (newline >= 0) {
            const data = JSON.parse(buffer.slice(0, newline)) as FaultCheckpoint;
            if (data.ready !== phase) throw new Error('fault checkpoint mismatch');
            return data;
          }
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('fault checkpoint timeout')), 12000);
      }),
    ]);
    child.kill('SIGKILL');
    const exit = await child.exited;
    if (exit === 0) throw new Error('fault worker was not interrupted');
    // A fresh connection proves the old transaction's locks were released by process death.
    await db.sql`select 1`;
    return checkpoint;
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    await child.exited;
    await reader.cancel();
    await errors;
  }
}
