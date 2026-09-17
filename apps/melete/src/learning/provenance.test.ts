import { describe, expect, test } from 'bun:test';
import { objectiveIsOwnerText } from './provenance.ts';

const owner = 'own_owner';
const job = (kind: string, principalId: string | null = owner, planId: string | null = null) => ({
  kind,
  principalId,
  planId,
});

describe('objective provenance', () => {
  test('a request the correcting owner typed may be quoted', () => {
    expect(objectiveIsOwnerText(job('responsibility'), owner)).toBe(true);
    expect(objectiveIsOwnerText(job('chat'), owner)).toBe(true);
    expect(objectiveIsOwnerText(job('plan'), owner)).toBe(true);
  });

  test('an objective built by an automation, a plan or another principal may not', () => {
    expect(objectiveIsOwnerText(job('routine'), owner)).toBe(false);
    expect(objectiveIsOwnerText(job('milestone'), owner)).toBe(false);
    expect(objectiveIsOwnerText(job('chat', owner, 'job_plan'), owner)).toBe(false);
    expect(objectiveIsOwnerText(job('responsibility', 'own_member'), owner)).toBe(false);
    expect(objectiveIsOwnerText(job('responsibility', null), owner)).toBe(false);
    expect(objectiveIsOwnerText(job('something-new'), owner)).toBe(false);
  });
});
