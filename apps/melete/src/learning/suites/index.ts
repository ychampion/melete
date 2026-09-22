/**
 * The suite registry. The first suite that supports a candidate's scope evaluates
 * it; a scope no suite supports cannot be evaluated at all.
 *
 * Every module a suite declares, and every module that grades or admits for any
 * suite, is hashed into the suite hash. A new check kind, a changed fixture or a
 * different grader therefore cannot reuse evidence produced before it existed.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ProcedureScope } from '../contracts.ts';
import { digest } from '../episodes.ts';
import { episodeDerivedSuite } from './episode-derived.ts';
import { recordsFixtureSuite } from './records.ts';
import type { EvaluationPhase, EvaluationSuite } from './types.ts';

export const SHARED_SUITE_MODULES = [
  'apps/melete/src/learning/checks.ts',
  'apps/melete/src/learning/admit.ts',
  'apps/melete/src/learning/discriminate.ts',
  'apps/melete/src/learning/suites/types.ts',
  'apps/melete/src/learning/gate.ts',
  'conformance/memory/harness.ts',
  'conformance/memory/provider.ts',
] as const;

/** Bundled suites first; the episode-derived suite covers every scope they do not. */
export const DEFAULT_SUITES: readonly EvaluationSuite[] = [
  recordsFixtureSuite,
  episodeDerivedSuite,
];

const repositoryRoot = new URL('../../../../../', import.meta.url);
export const repositoryPath = (path: string) => fileURLToPath(new URL(path, repositoryRoot));
export const readRepositoryFile = (path: string) => Bun.file(repositoryPath(path)).text();

export function resolveSuite(
  scope: ProcedureScope,
  suites: readonly EvaluationSuite[] = DEFAULT_SUITES,
): EvaluationSuite | null {
  return suites.find((suite) => suite.supports(scope)) ?? null;
}

/** Every module the evidence depends on, once each, in a fixed order. */
export const suiteModules = (suite: EvaluationSuite) => [
  ...new Set([...suite.modules, ...SHARED_SUITE_MODULES]),
];

/** A suite that cannot find its own code cannot say what its evidence means. */
export function assertSuiteModules(suites: readonly EvaluationSuite[]) {
  for (const suite of suites)
    for (const path of suiteModules(suite))
      if (!existsSync(repositoryPath(path))) throw new Error(`suite_module_missing:${path}`);
}

export async function suiteHash(input: {
  phase: EvaluationPhase;
  suite: EvaluationSuite;
  caseTemplates: readonly string[];
  memory: readonly unknown[];
  read?: (path: string) => Promise<string>;
}) {
  const read = input.read ?? readRepositoryFile;
  const code: Record<string, string> = {};
  for (const path of suiteModules(input.suite)) code[path] = digest(await read(path));
  return digest({
    phase: input.phase,
    suiteId: input.suite.id,
    caseTemplates: input.caseTemplates,
    memory: input.memory,
    code,
  });
}
