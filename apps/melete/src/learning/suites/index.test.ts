import { describe, expect, test } from 'bun:test';
import {
  assertSuiteModules,
  DEFAULT_SUITES,
  resolveSuite,
  SHARED_SUITE_MODULES,
  suiteHash,
  suiteModules,
} from './index.ts';
import { EVALUATED_SCOPE } from './records.ts';

describe('the evaluation suite registry', () => {
  test('the suite hash covers every module the registry supplies', async () => {
    expect(DEFAULT_SUITES.length).toBeGreaterThan(0);
    for (const suite of DEFAULT_SUITES) {
      const modules = suiteModules(suite);
      for (const path of [...suite.modules, ...SHARED_SUITE_MODULES])
        expect(modules).toContain(path);
      // The declared modules are real files, so the hash is over real code.
      expect(() => assertSuiteModules([suite])).not.toThrow();
      const files = new Map(modules.map((path) => [path, `source of ${path}`]));
      const hashWith = (content: Map<string, string>, overrides = {}) =>
        suiteHash({
          phase: 'validation',
          suite,
          caseTemplates: ['one', 'two', 'three'],
          memory: [{ id: 'scenario' }],
          read: async (path) => {
            const text = content.get(path);
            if (text === undefined) throw new Error(`unexpected module ${path}`);
            return text;
          },
          ...overrides,
        });
      const base = await hashWith(files);
      for (const path of modules) {
        const changed = new Map(files);
        changed.set(path, `${files.get(path)} // edited`);
        expect(await hashWith(changed)).not.toBe(base);
      }
      expect(await hashWith(files, { phase: 'sealed_final' })).not.toBe(base);
      expect(await hashWith(files, { caseTemplates: ['one', 'two', 'four'] })).not.toBe(base);
      expect(await hashWith(files, { memory: [] })).not.toBe(base);
      expect(await hashWith(files, { suite: { ...suite, id: 'another-suite/1' } })).not.toBe(base);
    }
  });

  test('a suite whose code is missing cannot be registered', () => {
    const [records] = DEFAULT_SUITES;
    if (!records) throw new Error('No suite');
    expect(() =>
      assertSuiteModules([{ ...records, modules: ['conformance/learning/not-there.ts'] }]),
    ).toThrow('suite_module_missing');
  });

  test('the first suite that supports a scope evaluates it, and nothing covers an unknown scope', () => {
    expect(resolveSuite(EVALUATED_SCOPE)?.id).toBe('records-fixtures/1');
    // Bundled fixtures win for their own scope; owner history covers every other one.
    expect(resolveSuite({ ...EVALUATED_SCOPE, task_family: 'general', app: 'melete' })?.id).toBe(
      'episode-derived/1',
    );
    const [records] = DEFAULT_SUITES;
    if (!records) throw new Error('No suite');
    expect(
      resolveSuite({ ...EVALUATED_SCOPE, task_family: 'no-such-family' }, [records]),
    ).toBeNull();
  });
});
