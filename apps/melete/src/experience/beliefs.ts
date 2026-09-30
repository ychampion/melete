/**
 * "What I believe about you": the person's side of memory. Every call runs in
 * the person's own memory scope and their own time zone; a space whose memory
 * is not connected answers with the same honest unavailable the saved-detail
 * routes give.
 */
import {
  beliefExportQuery,
  beliefImport,
  memoryTimelineQuery,
  rewindTarget,
  unavailable,
} from '@melete/contracts';
import { ServiceError } from '../api/errors.ts';
import {
  beliefHistory,
  blockBelief,
  listBeliefs,
  listBlocks,
  removeBlock,
} from '../memory/beliefs.ts';
import { latestDigest, markDigestSeen, spaceDay } from '../memory/digest.ts';
import {
  beliefMarkdown,
  exportBeliefFile,
  importBeliefFile,
  readBeliefFile,
} from '../memory/portable.ts';
import {
  applyRewind,
  memoryTimeline,
  previewRewind,
  resolveTarget,
  undoRewind,
} from '../memory/rewind.ts';
import type { ExperienceMemory } from './memory.ts';
import { experienceMissing } from './service.ts';

const NOT_CONNECTED = 'Your saved details are not connected yet.';

export class ExperienceBeliefs {
  constructor(readonly memory: ExperienceMemory) {}

  private async context(spaceId: string, ownerId: string) {
    const scope = await this.memory.scope(spaceId, ownerId);
    if (!scope) return null;
    const { timeZone } = await spaceDay(this.memory.sql, spaceId);
    return { scope, timeZone };
  }

  async list(spaceId: string, ownerId: string) {
    const context = await this.context(spaceId, ownerId);
    if (!context) return unavailable(NOT_CONNECTED);
    return {
      beliefs: await listBeliefs(this.memory.sql, context.scope, context.timeZone),
      time_zone: context.timeZone,
    };
  }
  async history(spaceId: string, ownerId: string, id: string) {
    const context = await this.context(spaceId, ownerId);
    if (!context) return unavailable(NOT_CONNECTED);
    return beliefHistory(this.memory.sql, context.scope, id, context.timeZone);
  }
  async block(spaceId: string, ownerId: string, id: string) {
    const context = await this.context(spaceId, ownerId);
    if (!context) return unavailable(NOT_CONNECTED);
    if (!this.memory.journal)
      return unavailable('Forgetting is not connected to the saved deletion history yet.');
    return blockBelief(this.memory.sql, context.scope, id, this.memory.journal);
  }
  async blocks(spaceId: string, ownerId: string) {
    const context = await this.context(spaceId, ownerId);
    if (!context) return unavailable(NOT_CONNECTED);
    return listBlocks(this.memory.sql, context.scope);
  }
  async unblock(spaceId: string, ownerId: string, id: string) {
    const context = await this.context(spaceId, ownerId);
    if (!context) return unavailable(NOT_CONNECTED);
    return removeBlock(this.memory.sql, context.scope, id);
  }
  async timeline(spaceId: string, ownerId: string, query: Record<string, string>) {
    const context = await this.context(spaceId, ownerId);
    if (!context) return unavailable(NOT_CONNECTED);
    const days = Math.min(Math.max(Number(memoryTimelineQuery.parse(query).days ?? 30), 1), 90);
    return memoryTimeline(this.memory.sql, context.scope, context.timeZone, days);
  }
  async preview(spaceId: string, ownerId: string, raw: unknown) {
    const context = await this.context(spaceId, ownerId);
    if (!context) return unavailable(NOT_CONNECTED);
    const window = await resolveTarget(
      this.memory.sql,
      context.scope,
      rewindTarget.parse(raw),
      context.timeZone,
    );
    return {
      label: window.label,
      ...(await previewRewind(this.memory.sql, context.scope, window)),
    };
  }
  async rewind(spaceId: string, ownerId: string, raw: unknown) {
    const context = await this.context(spaceId, ownerId);
    if (!context) return unavailable(NOT_CONNECTED);
    const target = rewindTarget.parse(raw);
    const window = await resolveTarget(this.memory.sql, context.scope, target, context.timeZone);
    return { rewind: await applyRewind(this.memory.sql, context.scope, window, target) };
  }
  async undoRewind(spaceId: string, ownerId: string, id: string) {
    const context = await this.context(spaceId, ownerId);
    if (!context) return unavailable(NOT_CONNECTED);
    return { rewind: await undoRewind(this.memory.sql, context.scope, id) };
  }
  async digest(spaceId: string, ownerId: string) {
    const context = await this.context(spaceId, ownerId);
    if (!context) return unavailable(NOT_CONNECTED);
    return latestDigest(this.memory.sql, context.scope);
  }
  async seen(spaceId: string, ownerId: string, id: string) {
    const context = await this.context(spaceId, ownerId);
    if (!context) return unavailable(NOT_CONNECTED);
    if (!(await markDigestSeen(this.memory.sql, context.scope, id))) throw experienceMissing();
    return { status: 'ok' as const };
  }
  async export(spaceId: string, ownerId: string, query: Record<string, string>) {
    const context = await this.context(spaceId, ownerId);
    if (!context) return unavailable(NOT_CONNECTED);
    const { format } = beliefExportQuery.parse(query);
    const file = await exportBeliefFile(this.memory.sql, context.scope, context.timeZone);
    const day = file.exported_at.slice(0, 10);
    return format === 'json'
      ? {
          format,
          filename: `melete-beliefs-${day}.json`,
          content: `${JSON.stringify(file, null, 2)}\n`,
        }
      : { format, filename: `melete-beliefs-${day}.md`, content: beliefMarkdown(file) };
  }
  async import(spaceId: string, ownerId: string, raw: unknown) {
    const context = await this.context(spaceId, ownerId);
    if (!context) return unavailable(NOT_CONNECTED);
    const input = beliefImport.parse(raw);
    let file: ReturnType<typeof readBeliefFile>;
    try {
      file = readBeliefFile(input.format, input.content);
    } catch {
      throw new ServiceError(
        'invalid_request',
        input.format === 'json'
          ? 'This is not a belief file Melete exported.'
          : 'No beliefs were found in this file.',
        400,
      );
    }
    return importBeliefFile(this.memory.sql, context.scope, file);
  }
}
