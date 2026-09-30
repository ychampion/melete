/**
 * Why an action was taken, as links a receipt or a permission card can show:
 * "because: <belief>" or "because: <your rule>".
 *
 * Three records answer it, best first. What the agent declared it used, when
 * its runtime recorded a manifest for the action. Otherwise what memory had
 * handed the turn the action came from, recorded by the database in the same
 * statement that proposed the action; that is labelled `recalled`, because the
 * agent did not say which of them it relied on. And the standing rule that let
 * the action go ahead without asking, when one did.
 */
import type { BecauseLink } from '@melete/contracts';
import type { Sql } from 'postgres';
import { ruleView } from '../experience/rules.ts';
import { subjectLabel } from './beliefs.ts';

const LIMIT = 20;
const short = (value: string, max = 80) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

async function beliefLinks(
  sql: Sql,
  spaceId: string,
  claims: { claim_id: string }[],
  basis: 'declared' | 'recalled',
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
    const [basis] = await sql`select items from memory_action_basis
      where action_id = ${actionId} and space_id = ${spaceId}`;
    const items = Array.isArray(basis?.items) ? (basis.items as { claim_id?: unknown }[]) : [];
    links = await beliefLinks(
      sql,
      spaceId,
      items.flatMap((item) =>
        typeof item.claim_id === 'string' ? [{ claim_id: item.claim_id }] : [],
      ),
      'recalled',
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
