/**
 * What the deployment needs from a host's Docker, judged before anything is built or started.
 * It prints the versions it read, so a refusal names the host it refused rather than a
 * requirement in the abstract, and exits non-zero with one line per problem.
 *
 * `bun run doctor --docker` makes the same judgement beside the suite's other prerequisites;
 * this asks about Docker alone, which is what a workflow that only starts the stack needs.
 */
import {
  DOCKER_REQUIREMENT,
  judgeHostDocker,
  readHostDocker,
} from '../../apps/melete/src/runtime/docker-engine.ts';

const outputs = readHostDocker();
const out = (line: string) => process.stdout.write(`${line}\n`);
const said = (output: { stdout: string; stderr: string }) =>
  output.stdout.trim() || output.stderr.trim() || 'no answer';

out(`docker version (api server): ${said(outputs.engine)}`);
out(`docker compose version: ${said(outputs.compose)}`);
const problems = judgeHostDocker(outputs);
for (const problem of problems) out(`  - ${problem}`);
out(
  problems.length
    ? `docker preflight: ${problems.length} problem(s) with this host. ${DOCKER_REQUIREMENT}.`
    : 'docker preflight: this host can run the deployment.',
);
process.exit(problems.length ? 1 : 0);
