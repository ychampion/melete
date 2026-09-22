/**
 * `bun run conformance` lists the ten scenarios and what each one will
 * assert, then runs the suite.
 *
 * Scenarios 1 through 5 use disposable databases and scripted runtimes;
 * scenarios 6 through 8 exercise the deployed services with explicit opt-in,
 * and scenario 10 a Docker engine with its own opt-in.
 */
import { fileURLToPath } from 'node:url';
import { composeEnabled, databaseUrl, dockerEnabled, waitForStack } from './helpers/compose.ts';
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

const deferred = SCENARIOS.filter((scenario) =>
  scenario.id === 10 ? !dockerEnabled : scenario.id >= 6 && !composeEnabled,
).length;
const enabled = SCENARIOS.length - deferred;
out(
  `${SCENARIOS.length} scenarios declared, ${enabled} enabled, ${deferred} deferred; ${assertions} declared checks.`,
);
out();
out('Scenarios 1–5 use isolated databases, scripted runtimes and the test destination.');
out('With MELETE_CONFORMANCE_COMPOSE=1, they use the Compose Postgres host,');
out('and scenarios 6–8 use the deployed web, API, broker and Hermes cells.');
out('With MELETE_CONFORMANCE_DOCKER=1, scenario 10 starts stdio MCP servers on the Docker engine.');
out('The optional second-provider comparison is skipped without configured credentials.');
out(
  'Without DATABASE_URL, tests start embedded Postgres 17; unavailable binaries produce explicit skips.',
);
out();
if (composeEnabled) await waitForStack();
const run = Bun.spawn([process.execPath, 'test', '--max-concurrency=1', 'conformance/scenarios'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
  env: { ...process.env, ...(composeEnabled ? { DATABASE_URL: await databaseUrl() } : {}) },
});
const code = await run.exited;
out();
out(
  `Conformance exit ${code}: ${enabled} scenarios enabled, ${deferred} deployment scenarios deferred.`,
);
if (deferred > 0)
  out(
    'Enable scenarios 6–8 with MELETE_CONFORMANCE_COMPOSE=1 on a disposable stack, and 10 with MELETE_CONFORMANCE_DOCKER=1.',
  );
process.exit(code);
