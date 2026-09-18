import { describe, expect, test } from 'bun:test';
import {
  type ObjectiveOrigin,
  objectiveIsOwnerText,
  recordedObjectiveOrigin,
} from './provenance.ts';

const owner = 'own_owner';
const job = (objectiveOrigin: ObjectiveOrigin | null, principalId: string | null = owner) => ({
  objectiveOrigin,
  principalId,
});

describe('objective provenance', () => {
  test('a request the correcting owner typed may be quoted', () => {
    expect(objectiveIsOwnerText(job('owner_request'), owner)).toBe(true);
  });

  test('an objective built by an automation, a plan or another principal may not', () => {
    expect(objectiveIsOwnerText(job('derived'), owner)).toBe(false);
    expect(objectiveIsOwnerText(job('owner_request', 'own_member'), owner)).toBe(false);
    expect(objectiveIsOwnerText(job('owner_request', null), owner)).toBe(false);
    // A job written before the origin was recorded is not quotable either.
    expect(objectiveIsOwnerText(job(null), owner)).toBe(false);
    expect(
      objectiveIsOwnerText({ objectiveOrigin: 'something-new', principalId: owner }, owner),
    ).toBe(false);
  });

  test('the origin is decided from how the job was made, not from its objective', () => {
    expect(recordedObjectiveOrigin({ kind: 'responsibility' })).toBe('owner_request');
    expect(recordedObjectiveOrigin({ kind: 'chat' })).toBe('owner_request');
    expect(recordedObjectiveOrigin({ kind: 'plan' })).toBe('owner_request');
    expect(recordedObjectiveOrigin({})).toBe('owner_request');
    expect(recordedObjectiveOrigin({ kind: 'routine' })).toBe('derived');
    expect(recordedObjectiveOrigin({ kind: 'milestone' })).toBe('derived');
    expect(recordedObjectiveOrigin({ kind: 'command' })).toBe('derived');
    expect(recordedObjectiveOrigin({ kind: 'chat', planId: 'job_plan' })).toBe('derived');
    expect(recordedObjectiveOrigin({ kind: 'something-new' })).toBe('derived');
  });
});
