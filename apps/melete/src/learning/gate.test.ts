import { describe, expect, test } from 'bun:test';
import { access, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decidePromotion, type GateInput } from './gate.ts';
import { compileProcedure } from './procedure.ts';
import { launchRestrictedModule, openPromoterProcess } from './promoter-process.ts';

const input = (): GateInput => ({
  phase: 'validation',
  definitionHash: 'a'.repeat(64),
  suiteHash: 'b'.repeat(64),
  target: 'skill_body',
  source: {
    family: 'records',
    template: 'training',
    space: 'origin',
    occurredAt: '2026-01-01T00:00:00Z',
  },
  rows: ['numeric', 'dates', 'text', 'authority'].map((template, index) => ({
    family: index === 3 ? 'authority' : 'records',
    template,
    space: `heldout-${index}`,
    occurredAt: '2026-02-01T00:00:00Z',
    baseline: index === 0 || index === 3 ? 1 : 0,
    candidate: 1,
    baselineCorrections: index === 0 || index === 3 ? 0 : 1,
    candidateCorrections: 0,
    scopeViolations: 0,
  })),
  criticalFamilies: ['authority'],
  budget: { jobs: 6, reservedTokens: 10000, durationMs: 100 },
  selection: null,
});
function row(value: GateInput, index: number) {
  const result = value.rows[index];
  if (!result) throw new Error('Missing gate fixture row');
  return result;
}

describe('held-out procedure gate', () => {
  test('selects validation and requires a later disjoint final set', () => {
    const value = input();
    expect(decidePromotion(value).decision).toBe('select');
    value.phase = 'sealed_final';
    expect(decidePromotion(value).reason).toBe('final_requires_prior_selection');
    value.selection = {
      definitionHash: value.definitionHash,
      selectedAt: '2026-02-02T00:00:00Z',
      latestInstanceAt: '2026-02-01T00:00:00Z',
      templates: value.rows.map((row) => row.template),
      spaces: value.rows.map((row) => row.space),
    };
    expect(decidePromotion(value).reason).toBe('final_partition_overlap');
    value.rows = value.rows.map((row) => ({
      ...row,
      template: `final-${row.template}`,
      space: `final-${row.space}`,
      occurredAt: '2026-03-01T00:00:00Z',
    }));
    expect(decidePromotion(value).decision).toBe('allow_canary');
  });
  test('rejects negative transfer even when family average improves', () => {
    const value = input();
    row(value, 0).candidate = 0;
    row(value, 0).candidateCorrections = 1;
    expect(
      value.rows.slice(0, 3).reduce((sum, row) => sum + row.candidate - row.baseline, 0),
    ).toBeGreaterThan(0);
    expect(decidePromotion(value).reason).toStartWith('negative_transfer:records:numeric');
  });
  test('fails closed on a critical family, scope violation, or training overlap', () => {
    const critical = input();
    row(critical, 3).baseline = 0;
    row(critical, 3).candidate = 0;
    expect(decidePromotion(critical).reason).toBe('critical_family_failed:authority');
    const scope = input();
    row(scope, 0).scopeViolations = 1;
    expect(decidePromotion(scope).reason).toBe('scope_violation');
    for (const key of ['template', 'space', 'occurredAt'] as const) {
      const value = input();
      row(value, 0)[key] = value.source[key];
      expect(decidePromotion(value).reason).toBe('training_partition_overlap');
    }
  });
  test('the candidate and gate schemas refuse all six forbidden targets', () => {
    for (const target of [
      'authorizer',
      'credential_service',
      'space_boundary',
      'operation_identity',
      'grader',
      'sealed_final_tasks',
    ]) {
      expect(() => decidePromotion({ ...input(), target })).toThrow();
      expect(() =>
        compileProcedure({ target, steps: ['sort-typed-values'], test: 'ordering-and-shape' }),
      ).toThrow();
      expect(() =>
        compileProcedure({
          target: 'skill_body',
          steps: ['sort-typed-values'],
          test: 'ordering-and-shape',
          path: target,
        }),
      ).toThrow();
    }
  });
  test('the restricted promoter returns only the bound decision', async () => {
    const process = await openPromoterProcess();
    try {
      expect(await process.decide(input())).toEqual(decidePromotion(input()));
    } finally {
      await process.close();
    }
  }, 15000);
  test('the same process boundary denies opening every forbidden target for writing', async () => {
    const paths = [
      'apps/melete/src/broker/authority.ts',
      'apps/melete/src/connectors/secrets.ts',
      'apps/melete/src/memory/db.ts',
      'apps/melete/src/broker/service.ts',
      'conformance/learning/records.ts',
      'conformance/learning/sealed-final.ts',
    ].map((path) => resolve(path));
    for (const target of paths) await access(target);
    const directory = await mkdtemp(join(tmpdir(), 'melete-permission-probe-'));
    const path = join(directory, 'probe.mjs');
    // Opening append-only exercises write permission without changing bytes even if it succeeds.
    await writeFile(
      path,
      `import fs from 'node:fs'; let raw=''; for await (const b of process.stdin) raw+=b;
      const results=JSON.parse(raw).map(path=>{try{const fd=fs.openSync(path,'a');fs.closeSync(fd);return {path,code:'OPENED'};}catch(e){return {path,code:e.code,permission:e.permission};}});
      process.stdout.write(JSON.stringify(results));`,
    );
    try {
      const child = launchRestrictedModule(path, paths);
      const results = JSON.parse(await new Response(child.stdout).text());
      expect(await child.exited).toBe(0);
      expect(results).toHaveLength(6);
      for (const result of results)
        expect(result).toMatchObject({ code: 'ERR_ACCESS_DENIED', permission: 'FileSystemWrite' });
    } finally {
      await rm(path);
      await rmdir(directory);
    }
  }, 15000);
});
