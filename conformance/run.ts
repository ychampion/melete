/**
 * `bun run conformance` lists the eight scenarios and what each one will
 * assert, then runs the suite.
 *
 * Today every assertion is a `test.todo`, so the run is green and says plainly
 * that nothing has been proved yet. That is the honest state of a pre-release,
 * and it makes the shape of the proof reviewable before the service exists.
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
out('Every assertion is currently a todo: the service they run against does not');
out('exist yet. Run `bun test conformance` to see them listed by the test runner.');
