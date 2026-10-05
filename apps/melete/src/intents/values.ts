/**
 * An intent's details as paths and values, in a fixed order: what origin
 * marking walks, and what the broker compares a payload's values against.
 */
import type { IntentConstraints } from '@melete/contracts';

export type Leaf = {
  path: string;
  value: string | number;
  type: 'text' | 'tag' | 'number' | 'amount' | 'currency' | 'when';
};

/** Every detail as a path and a value, in a fixed order. */
export function leaves(constraints: IntentConstraints, deadline?: string | null): Leaf[] {
  const out: Leaf[] = [];
  const add = (path: string, value: unknown, type: Leaf['type']) => {
    if (value === undefined || value === null || value === '') return;
    out.push({ path, value: value as string | number, type });
  };
  const c = constraints;
  add('place.name', c.place?.name, 'text');
  add('place.kind', c.place?.kind, 'text');
  add('place.near', c.place?.near, 'text');
  add('party.size', c.party?.size, 'number');
  c.party?.contacts?.forEach((value, index) => {
    add(`party.contacts[${index}]`, value, 'text');
  });
  add('window.from', c.window?.from, 'when');
  add('window.to', c.window?.to, 'when');
  add('deadline_at', deadline, 'when');
  add('budget.max', c.budget?.max, 'amount');
  add('budget.currency', c.budget?.currency, 'currency');
  c.must?.forEach((value, index) => {
    add(`must[${index}]`, value, 'tag');
  });
  c.must_not?.forEach((value, index) => {
    add(`must_not[${index}]`, value, 'tag');
  });
  c.counterparties?.forEach((value, index) => {
    add(`counterparties[${index}]`, value, 'text');
  });
  add('deliverable', c.deliverable, 'text');
  add('notes', c.notes, 'text');
  return out;
}
