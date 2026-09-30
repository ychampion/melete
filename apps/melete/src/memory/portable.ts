/**
 * Beliefs out and in, as a file the person keeps.
 *
 * Memory belongs to the person, not to a model: it lives in the service's own
 * store, and the model is only asked to read new messages. The export carries
 * every belief's value, subject, kind, source in plain words and history, as
 * JSON or as Markdown a person can read; the import reads either back. An
 * imported belief is recorded as something the person brought in themselves,
 * cites the line it came from, and never overwrites a different current value:
 * that one is left alone and named in the result.
 */
import { createHash } from 'node:crypto';
import {
  BELIEF_CATEGORIES,
  BELIEF_FILE_FORMAT,
  type BeliefCategory,
  type BeliefFile,
  beliefFile,
  isMemoryKey,
} from '@melete/contracts';
import { beliefHistory, blockedSubjects, isBlocked, listBeliefs } from './beliefs.ts';
import { getHead, publishRevision } from './claims.ts';
import { lockSpace, MemoryError, type MemoryScope, type MemorySql } from './db.ts';
import { persistEvidence } from './evidence.ts';
import { lockEventOrder, notifyInvalidated } from './invalidate.ts';
import { assertMemoryDomain } from './resolve.ts';

export const CATEGORY_TITLE: Record<BeliefCategory, string> = {
  people: 'People',
  preferences: 'Preferences',
  accounts: 'Accounts and bills',
  routines: 'Routines and dates',
  work: 'Work',
  other: 'Everything else',
};

export async function exportBeliefFile(
  sql: MemorySql,
  scope: MemoryScope,
  timeZone: string,
  now = new Date(),
): Promise<BeliefFile> {
  const beliefs = await listBeliefs(sql, scope, timeZone);
  const entries: BeliefFile['beliefs'] = [];
  for (const belief of beliefs) {
    const [claim] = await sql`select domain_key, key from memory_claims where id = ${belief.id}`;
    const [revision] = await sql`select r.kind from memory_claims c
      join memory_revisions r on r.claim_id = c.id and r.revision = c.head_revision where c.id = ${belief.id}`;
    const history = await beliefHistory(sql, scope, belief.id, timeZone);
    entries.push({
      label: belief.label,
      value: belief.value,
      category: belief.category,
      subject: String(claim?.domain_key ?? belief.label),
      key: claim?.key ? String(claim.key) : null,
      kind: String(revision?.kind ?? 'user_statement'),
      trust: belief.trust,
      source: belief.source.text,
      learned_at: belief.learned_at,
      history: history.versions
        .filter((version) => !version.current)
        .map((version) => ({ value: version.value, at: version.at })),
    });
  }
  return {
    format: BELIEF_FILE_FORMAT,
    version: 1,
    exported_at: now.toISOString(),
    beliefs: entries,
  };
}

const oneLine = (value: string) => value.replaceAll(/\s*\n\s*/g, ' ').trim();

/**
 * Markdown a person can read and edit. Each belief is one list item; the
 * subject rides in a trailing comment so an import lands on the same subject.
 */
export function beliefMarkdown(file: BeliefFile): string {
  const lines = [
    '# What Melete believes about you',
    '',
    `Exported ${file.exported_at.slice(0, 10)}. Each line is one belief: what it is about, what I believe, and where it came from.`,
  ];
  for (const category of BELIEF_CATEGORIES) {
    const entries = file.beliefs.filter((entry) => entry.category === category);
    if (!entries.length) continue;
    lines.push('', `## ${CATEGORY_TITLE[category]}`, '');
    for (const entry of entries)
      lines.push(
        `- **${oneLine(entry.label).replaceAll('*', '')}**: ${oneLine(entry.value)} (${oneLine(entry.source)}) <!-- ${entry.subject} -->`,
      );
  }
  return `${lines.join('\n')}\n`;
}

const TITLE_CATEGORY = new Map(
  Object.entries(CATEGORY_TITLE).map(([category, title]) => [title.toLowerCase(), category]),
);
const slug = (value: string) =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '')
    .slice(0, 80) || 'belief';

/** Read the Markdown an export wrote, or one a person wrote in the same shape. */
export function parseBeliefMarkdown(text: string): BeliefFile {
  let category: BeliefCategory = 'other';
  const beliefs: BeliefFile['beliefs'] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      category = (TITLE_CATEGORY.get((heading[1] ?? '').trim().toLowerCase()) ??
        'other') as BeliefCategory;
      continue;
    }
    const item =
      /^[-*]\s+\*\*(.+?)\*\*:\s*(.+?)\s*(?:\(([^()]*)\))?\s*(?:<!--\s*(.+?)\s*-->)?$/.exec(line);
    if (!item) continue;
    const label = (item[1] ?? '').trim();
    const value = (item[2] ?? '').trim();
    if (!label || !value) continue;
    beliefs.push({
      label,
      value,
      category,
      subject: (item[4] ?? '').trim() || `imported.${slug(label)}`,
      key: null,
      kind: category === 'preferences' ? 'preference' : 'user_statement',
      trust: 'yours',
      source: (item[3] ?? 'imported').trim() || 'imported',
      learned_at: new Date(0).toISOString(),
      history: [],
    });
  }
  return beliefFile.parse({
    format: BELIEF_FILE_FORMAT,
    version: 1,
    exported_at: new Date().toISOString(),
    beliefs,
  });
}

/** Import a belief file into this space. Existing values are never overwritten. */
export async function importBeliefFile(sql: MemorySql, scope: MemoryScope, file: BeliefFile) {
  let imported = 0;
  let skipped = 0;
  const notes: string[] = [];
  const blocked = await blockedSubjects(sql, scope.spaceId);
  const importedAt = new Date().toISOString();
  for (const entry of file.beliefs) {
    let domain = entry.subject.trim();
    try {
      assertMemoryDomain(domain);
    } catch {
      domain = `imported.${slug(entry.label)}`;
    }
    const key = entry.key && isMemoryKey(entry.key) ? entry.key : null;
    if (isBlocked(blocked, { domain_key: domain, key })) {
      skipped++;
      if (notes.length < 50) notes.push(`${entry.label}: you asked me not to learn this again.`);
      continue;
    }
    const outcome = await sql.begin(async (tx) => {
      await lockEventOrder(tx);
      await lockSpace(tx, scope);
      const [existing] = await tx`select id from memory_claims where space_id = ${scope.spaceId}
        and audience = ${scope.audience} and not hidden
        and (domain_key = ${domain} or (${key}::text is not null and key = ${key}))
        order by (domain_key = ${domain}) desc limit 1`;
      const head = existing ? await getHead(tx, scope, String(existing.id)) : null;
      const live = head && ['active', 'disputed'].includes(head.current.status);
      if (live && head.current.content === entry.value) return 'same' as const;
      if (live) return 'different' as const;
      if (head && head.domain_key !== domain) return 'different' as const;
      const text = `${entry.label}: ${entry.value}`;
      const evidence = await persistEvidence(tx, scope, {
        stream: 'import',
        source_identity: createHash('sha256')
          .update(JSON.stringify([domain, entry.value]))
          .digest('hex'),
        source_version: '1',
        source_type: 'message',
        author: 'owner',
        event_at: importedAt,
        text,
      });
      if (evidence.source.state !== 'active') return 'refused' as const;
      await publishRevision(tx, scope, domain, head, {
        key,
        content: entry.value,
        kind: entry.kind === 'preference' ? 'preference' : 'user_statement',
        factual_status: 'attributed',
        valid_from: importedAt,
        valid_until: null,
        protected: false,
        sources: [
          {
            source_id: evidence.source.source_id,
            source_version: evidence.source.source_version,
            start: 0,
            end: text.length,
          },
        ],
      });
      // The line is the belief's evidence already; nothing is left to read from it.
      await tx`update memory_work set status = 'done' where source_id = ${evidence.source.source_id}`;
      await tx`update memory_streams set consumed_sequence = committed_sequence
        where space_id = ${scope.spaceId} and publisher = ${scope.publisher} and stream = 'import'`;
      return 'imported' as const;
    });
    if (outcome === 'imported') imported++;
    else {
      skipped++;
      if (outcome !== 'same' && notes.length < 50)
        notes.push(
          outcome === 'different'
            ? `${entry.label}: you already have a different value, so yours was kept.`
            : `${entry.label}: this could not be saved here.`,
        );
    }
  }
  await notifyInvalidated(sql, scope.spaceId);
  return { imported, skipped, notes };
}

/** Parse an import request's content in its declared format. */
export function readBeliefFile(format: 'json' | 'markdown', content: string): BeliefFile {
  if (format === 'markdown') return parseBeliefMarkdown(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new MemoryError('invalid_request');
  }
  const result = beliefFile.safeParse(parsed);
  if (!result.success) throw new MemoryError('invalid_request');
  return result.data;
}
