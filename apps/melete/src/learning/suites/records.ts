/**
 * The bundled records fixtures, unchanged: three validation tables, three sealed
 * final tables loaded only after selection commits, and a grader that compares
 * against fixture-declared row identities rather than re-running a sort.
 */
import { type RecordCase, taskObjective } from '../../../../../conformance/learning/records.ts';
import {
  validationCases,
  validationMemory,
} from '../../../../../conformance/learning/validation.ts';
import type { ProcedureScope } from '../contracts.ts';
import { scopeMatches } from '../selection.ts';
import { type EvaluationCase, type EvaluationSuite, gradeFinished } from './types.ts';

export const EVALUATED_SCOPE: ProcedureScope = {
  task_family: 'organize-records',
  app: 'table-editor',
  app_version: '1.0',
  role: 'owner',
  audience: 'private',
};

const asCase = (value: RecordCase): EvaluationCase => ({
  template: value.template,
  objective: taskObjective(value.task),
  origin: 'fixture',
  input: { columns: [...value.task.columns], rows: [...value.task.rows] },
  expected: { row_ids: [...value.expectedIds] },
});

export const recordsFixtureSuite: EvaluationSuite = {
  id: 'records-fixtures/1',
  modules: [
    'conformance/learning/records.ts',
    'conformance/learning/validation.ts',
    'conformance/learning/sealed-final.ts',
    'apps/melete/src/learning/suites/records.ts',
  ],
  supports: (scope) => scopeMatches(scope, EVALUATED_SCOPE),
  async plan({ candidate }) {
    return {
      candidate,
      validation: { cases: validationCases.map(asCase), memory: validationMemory },
      // The seed is ignored: these final tables are fixed, and sealed by being loaded late.
      async sealedFinal() {
        const final = await import('../../../../../conformance/learning/sealed-final.ts');
        return { cases: final.sealedFinalCases().map(asCase), memory: final.sealedFinalMemory };
      },
    };
  },
  grade: (value, run) => gradeFinished([{ kind: 'records_expected_order' }], value, run),
};
