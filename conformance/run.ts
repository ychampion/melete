/**
 * `bun run conformance` lists the eight scenarios and what each one will
 * assert, then runs the suite.
 *
 * Scenarios 3 and 4 use a real Postgres and test destination. Other scenario
 * files retain their explicit todos until their implementations land.
 */
import { fileURLToPath } from 'node:url';
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
out('Scenarios 3 and 4 execute against isolated Postgres and the test destination.');
out('Scenarios 1, 2, 5, 6, 7 and 8 still contain explicit todos in this checkout.');
out(
  'Without DATABASE_URL, tests start embedded Postgres 17; unavailable binaries produce explicit skips.',
);
out();
const run = Bun.spawn([process.execPath, 'test', '--max-concurrency=2', 'conformance/scenarios'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exit(await run.exited);
