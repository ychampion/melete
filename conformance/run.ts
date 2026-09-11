/**
 * `bun run conformance` lists the eight scenarios and what each one will
 * assert, then runs the suite.
 *
 * Implemented assertions execute against disposable Postgres with scripted
 * runtimes; the remaining scenarios stay visibly marked as todo.
 */
import { SCENARIOS } from './scenarios.ts';

const out = (line = '') => process.stdout.write(`${line}\n`);

out('Melete conformance suite');
out('========================');
out();

let assertions = 0;
for (const scenario of SCENARIOS) {
  assertions += scenario.assertions.length;
  out(`${scenario.id}. ${scenario.title}`);
  out(`   ${scenario.text}`);
  for (const assertion of scenario.assertions) out(`   - ${assertion}`);
  out();
}

out(`${SCENARIOS.length} scenarios, ${assertions} assertions.`);
out();
const result = Bun.spawn([process.execPath, 'test', 'conformance'], {
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exitCode = await result.exited;
