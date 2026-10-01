/**
 * Why an action was taken, as links a receipt or a permission card can show:
 * "because: <belief>" or "because: <your rule>".
 *
 * Three records answer it, best first. What the agent declared it used, when
 * its runtime recorded a manifest for the action. Otherwise what memory had
 * handed the turn the action came from, recorded by the database in the same
 * statement that proposed the action; that is labelled `recalled`, because the
 * agent did not say which of them it relied on. A turn recalls everything that
 * might help, so a recalled belief is named only when the action itself bears
 * on it: a name, address, number or distinctive word of the belief appears in
 * what the action would do (its recipients, subject, text, file). When none
 * does, nothing is named rather than every belief the turn had in mind. And
 * the standing rule that let the action go ahead without asking, when one did.
 */
import type { BecauseLink } from '@melete/contracts';
import type { Sql } from 'postgres';
import { ruleView } from '../experience/rules.ts';
import { subjectLabel } from './beliefs.ts';

const LIMIT = 20;
const short = (value: string, max = 80) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

/** Words too common to tie a belief to an action. */
const COMMON = new Set(
  `about above after again also always another because been before being below between
  both cannot could does doing down during each even every from further have having here
  into just like made make more most much must never next once only other over same should
  some such than that their them then there these they this those through under until very
  were what when where which while with would your yours prefers prefer likes loves usually
  often sometimes person people thing things something someone today tomorrow yesterday
  week weekend month year time times date name kind value note notes detail details info
  information email emails message messages send sent please thanks file files text test
  pref fact contact event constraint profile`.split(/\s+/),
);

/** What a belief can be recognised by: addresses, numbers, names and distinctive words. */
export function beliefTerms(key: string | null, content: string): string[] {
  const terms = new Set<string>();
  const text = `${content} ${(key ?? '').split('.').slice(1).join(' ')}`.toLowerCase();
  for (const match of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}._%+-]*@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu))
    terms.add(match[0]);
  // A number is known by its last seven digits, so "+1 (415) 555-0134" is "4155550134" too.
  for (const match of text.matchAll(/\+?\d[\d ()-]{5,}\d/g))
    terms.add(match[0].replace(/\D/g, '').slice(-7));
  for (const word of text.split(/[^\p{L}\p{N}]+/u))
    if (word.length >= 4 && !COMMON.has(word) && !/^\d+$/.test(word)) terms.add(word);
  return [...terms];
}

/** Every string an action carries, read as one lower-case text. */
function payloadText(value: unknown): string {
  const strings: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === 'string') strings.push(node);
    else if (typeof node === 'number') strings.push(String(node));
    else if (Array.isArray(node)) for (const item of node) walk(item);
    else if (node && typeof node === 'object') for (const item of Object.values(node)) walk(item);
  };
  walk(value);
  return strings.join('\n').toLowerCase();
}

/** Whether what an action would do names something the belief is about. */
export function bearsOn(payload: unknown, terms: readonly string[]): boolean {
  const text = payloadText(payload);
  if (!text) return false;
  const words = new Set(text.split(/[^\p{L}\p{N}]+/u));
  // Numbers as written, with the spaces, brackets and dashes inside them taken out.
  const numbers = text.replace(/(?<=\d)[ ()-]+(?=\d)/g, '').match(/\d+/g) ?? [];
  return terms.some((term) =>
    term.includes('@')
      ? text.includes(term)
      : /^\d+$/.test(term)
        ? numbers.some((number) => number.includes(term))
        : words.has(term),
  );
}

async function beliefLinks(
  sql: Sql,
  spaceId: string,
  claims: { claim_id: string }[],
  basis: 'declared' | 'recalled',
  /** For recalled beliefs: what the action would do, which must bear on each one named. */
  payload?: unknown,
): Promise<BecauseLink[]> {
  const ids = [...new Set(claims.map((claim) => claim.claim_id))].slice(0, LIMIT);
  if (!ids.length) return [];
  // The belief as it reads now: a forgotten one is not named, a corrected one
  // links to its current value, which is what the person can open.
  const rows = await sql`select c.id, c.key, c.domain_key, b.content from memory_claims c
    join memory_revisions r on r.claim_id = c.id and r.revision = c.head_revision
    join memory_revision_content b on b.claim_id = r.claim_id and b.revision = r.revision
    where c.space_id = ${spaceId} and c.id = any(${ids}) and not c.hidden
      and r.status in ('active','disputed')`;
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [];
    if (
      basis === 'recalled' &&
      !bearsOn(payload, beliefTerms(row.key as string | null, String(row.content)))
    )
      return [];
    const label = subjectLabel(row.key as string | null, String(row.domain_key));
    return [
      { kind: 'belief' as const, id, label: `${label}: ${short(String(row.content))}`, basis },
    ];
  });
}

export async function actionBecause(
  sql: Sql,
  spaceId: string,
  actionId: string,
): Promise<BecauseLink[]> {
  const declared = await sql`select u.claim_id from memory_outputs o
    join memory_output_uses u on u.output_row_id = o.id
    where o.space_id = ${spaceId} and o.kind = 'action' and o.output_id = ${actionId}
      and u.handle_kind = 'claim' and u.claim_id is not null`;
  let links: BecauseLink[] = [];
  if (declared.length)
    links = await beliefLinks(
      sql,
      spaceId,
      declared.map((row) => ({ claim_id: String(row.claim_id) })),
      'declared',
    );
  else {
    const [basis] = await sql`select b.items, a.canonical_payload from memory_action_basis b
      join action a on a.id = b.action_id
      where b.action_id = ${actionId} and b.space_id = ${spaceId}`;
    const items = Array.isArray(basis?.items) ? (basis.items as { claim_id?: unknown }[]) : [];
    links = await beliefLinks(
      sql,
      spaceId,
      items.flatMap((item) =>
        typeof item.claim_id === 'string' ? [{ claim_id: item.claim_id }] : [],
      ),
      'recalled',
      basis?.canonical_payload,
    );
  }
  const rules = await sql`select r.* from experience_rule_use u
    join experience_rule r on r.id = u.rule_id
    where u.action_id = ${actionId} and r.space_id = ${spaceId}`;
  for (const rule of rules) {
    let text = 'A standing rule you set';
    try {
      text = `Your rule: ${ruleView(rule).text}`;
    } catch {
      // A rule kind this version cannot describe is still named as a rule.
    }
    links.push({ kind: 'rule', id: String(rule.id), label: short(text, 160), basis: 'rule' });
  }
  return links.slice(0, LIMIT);
}
