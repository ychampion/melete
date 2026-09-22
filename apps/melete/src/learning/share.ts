/**
 * Before a procedure is delivered to everyone in a space, its body is checked
 * against what the owner keeps private there.
 *
 * Steps descend from the owner's own words, and those words can carry a name, an
 * address or an amount the owner never meant to share. Private delivery never
 * leaves the owner, so it is not checked; sharing is. The check reads the owner's
 * private memory in the origin space (the head content of every visible claim and
 * the subject slug inside each registry key) and refuses the share when the body
 * contains a typed value found in that memory, a claim's whole content, or a slug.
 */
import { normalizeForMatch } from '@melete/contracts';
import { sql } from 'drizzle-orm';
import type { Transaction } from '../db/transaction.ts';
import { tier0Values } from '../memory/tier0.ts';

const MIN_SHARED_TERM = 4;

const containsWholeWords = (body: string, term: string) => {
  const needle = normalizeForMatch(term);
  return needle.length >= MIN_SHARED_TERM && ` ${body} `.includes(` ${needle} `);
};

/** The kind of private material the body contains, or null when it may be shared. */
export async function unshareableContent(
  tx: Transaction,
  spaceId: string,
  body: string,
): Promise<'typed_value' | 'claim_content' | 'slug' | null> {
  const claims = await tx.execute(sql`
    select claim.key, content.content
    from memory_claims claim
    join memory_revision_content content
      on content.claim_id = claim.id and content.revision = claim.head_revision
    where claim.space_id = ${spaceId} and claim.audience = 'private' and not claim.hidden`);
  const normalized = normalizeForMatch(body);
  const now = new Date().toISOString();
  for (const claim of claims) {
    const content = String(claim.content ?? '');
    // A relative date ("today") is not private material; one with digits in it is.
    for (const value of tier0Values(content, { eventAt: now }))
      if (
        (value.type !== 'date' || /\d/.test(value.text)) &&
        (containsWholeWords(normalized, value.text) || containsWholeWords(normalized, value.value))
      )
        return 'typed_value';
    if (containsWholeWords(normalized, content)) return 'claim_content';
    const slug = typeof claim.key === 'string' ? claim.key.split('.')[1] : undefined;
    if (
      slug &&
      (containsWholeWords(normalized, slug) ||
        containsWholeWords(normalized, slug.replace(/-/g, ' ')))
    )
      return 'slug';
  }
  return null;
}
