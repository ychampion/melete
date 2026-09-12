/**
 * The style conformance check.
 *
 * `checkStyle` in the contracts package is the rule; this file is the proof
 * that the rule decides the cases it claims to decide. It runs every sample
 * through the check and reports any sample whose verdict differs from the one
 * written next to it.
 *
 * Run it with `bun run conformance/style/check.ts`.
 */
import { checkStyle, type StyleViolationCode } from '@melete/contracts';
import { ALL_SAMPLES, type StyleSample } from './samples.ts';

export type SampleVerdict = {
  sample: StyleSample;
  actual: StyleViolationCode[];
  ok: boolean;
};

export type StyleReport = {
  verdicts: SampleVerdict[];
  passed: number;
  failed: number;
};

const same = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

export function runStyleCheck(samples: readonly StyleSample[] = ALL_SAMPLES): StyleReport {
  const verdicts = samples.map((sample) => {
    const actual = checkStyle(sample.text, { reply_class: sample.reply_class }).map(
      (violation) => violation.code,
    );
    return { sample, actual, ok: same(actual, sample.expect) };
  });
  return {
    verdicts,
    passed: verdicts.filter((verdict) => verdict.ok).length,
    failed: verdicts.filter((verdict) => !verdict.ok).length,
  };
}

if (import.meta.main) {
  const report = runStyleCheck();
  const out = (line = '') => process.stdout.write(`${line}\n`);
  out('Melete reply-style check');
  out('========================');
  out();
  for (const verdict of report.verdicts) {
    const expected = verdict.sample.expect.join(', ') || 'clean';
    const actual = verdict.actual.join(', ') || 'clean';
    out(`${verdict.ok ? 'ok  ' : 'FAIL'} ${verdict.sample.name}`);
    if (!verdict.ok) out(`     expected ${expected}; got ${actual}`);
  }
  out();
  out(`${report.passed} passed, ${report.failed} failed.`);
  process.exit(report.failed === 0 ? 0 : 1);
}
