import { describe, expect, test } from 'bun:test';
import { estimateTokens } from '@melete/skills';
import { compileProcedure, definitionHash, STEP_BODIES } from './procedure.ts';

describe('bounded procedure proposals', () => {
  test('composes a short reusable skill and a fixed test without private prose', () => {
    const compiled = compileProcedure({
      target: 'skill_body',
      steps: ['sort-typed-values', 'keep-header-and-rows'],
      test: 'ordering-and-shape',
    });
    expect(compiled.body).toContain(STEP_BODIES['sort-typed-values']);
    expect(estimateTokens(compiled.body)).toBeLessThanOrEqual(400);
    expect(compiled.tests).toEqual(['ordering-and-shape']);
  });

  test('private output and forbidden edit targets fail before any publication capability is called', () => {
    const proposal = {
      target: 'skill_body',
      steps: ['sort-typed-values'],
      test: 'ordering-and-shape',
    };
    for (const target of [
      'authorizer',
      'credential_service',
      'space_boundary',
      'operation_identity',
      'grader',
      'sealed_final_tasks',
      '../../skills/live.md',
    ]) {
      expect(() => compileProcedure({ ...proposal, target })).toThrow();
    }
    expect(() => compileProcedure({ ...proposal, body: 'PLANTED-SECRET-319' })).toThrow();
    expect(() => compileProcedure({ ...proposal, steps: ['PLANTED-SECRET-319'] })).toThrow();
    expect(() =>
      compileProcedure({ ...proposal, steps: ['sort-typed-values', 'sort-text-values'] }),
    ).toThrow();
  });

  test('scope and model changes invalidate the evaluated definition', () => {
    const compiled = compileProcedure({
      target: 'skill_body',
      steps: ['sort-typed-values'],
      test: 'ordering-and-shape',
    });
    const candidate = {
      ...compiled,
      scope: {
        task_family: 'organize-records',
        app: 'table-editor',
        app_version: '1.0',
        role: 'owner' as const,
        audience: 'private' as const,
      },
      compatibleModels: ['fake/scripted-learning-v1'],
    };
    const hash = definitionHash(candidate);
    expect(
      definitionHash({ ...candidate, scope: { ...candidate.scope, app_version: '2.0' } }),
    ).not.toBe(hash);
    expect(definitionHash({ ...candidate, compatibleModels: ['another/model'] })).not.toBe(hash);
  });
});
