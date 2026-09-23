/**
 * The workflows run on hosted runners nobody can step through, so everything they name is
 * checked here first: the YAML parses, each package script and file they refer to exists, every
 * action is pinned to a commit, and no secret is read. Both files are covered: the pull-request
 * workflow and the conformance run with its upgrade proof.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { parseArguments } from './upgrade.ts';

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = {
  'runs-on'?: string;
  'timeout-minutes'?: number;
  services?: Record<string, { image?: string; env?: Record<string, string>; ports?: string[] }>;
  env?: Record<string, string>;
  steps?: Step[];
};
type Workflow = {
  on?: {
    pull_request?: unknown;
    push?: { branches?: string[]; paths?: string[] };
    schedule?: { cron?: string }[];
    workflow_dispatch?: unknown;
  };
  permissions?: Record<string, string>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs?: Record<string, Job>;
};

const root = fileURLToPath(new URL('../..', import.meta.url));
/** The renderer sandbox proof, which the browser-sandbox job runs inside the worker container. */
const SANDBOX_PROOF = 'apps/melete/test/integration/browser-sandbox.test.ts';

function load(relative: string) {
  const path = join(root, relative);
  const source = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const workflow = (source ? parse(source) : {}) as Workflow;
  const named = Object.entries(workflow.jobs ?? {});
  const jobs = named.map(([, job]) => job);
  const steps = jobs.flatMap((job) => job.steps ?? []);
  const commands = steps.flatMap((step) => (step.run ?? '').split('\n')).map((line) => line.trim());
  return { source, workflow, named, jobs, steps, commands };
}

const ci = load('.github/workflows/ci.yml');
const conformance = load('.github/workflows/conformance.yml');
const scripts = (
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;
const jobs = ci.jobs;
const steps = ci.steps;
const commands = ci.commands;

/** Whatever the workflows name on disk has to be there: a script, a Dockerfile, a test. */
function filesNamed(lines: string[]): string[] {
  // The upgrade runs the script from an archive of this tree, so it names this tree's file.
  const released = (line: string) => line.replace(/"\$RUNNER_TEMP\/release\/(\S+?)"/g, '$1');
  return lines
    .map(released)
    .flatMap((line) => [
      ...(/^bun run (\S+\.ts)/.exec(line)?.slice(1) ?? []),
      ...(/^bun test (\S+\.ts)/.exec(line)?.slice(1) ?? []),
      ...(/docker compose -f (\S+)/.exec(line)?.slice(1) ?? []),
      ...(/ -f (\S+\.\w+)(?: |$)/.exec(line.startsWith('docker build') ? line : '')?.slice(1) ??
        []),
    ]);
}

describe('the continuous integration workflow', () => {
  test('parses and runs on pull requests and pushes to main', () => {
    expect(ci.source).not.toBe('');
    expect(ci.workflow.on).toHaveProperty('pull_request');
    expect(ci.workflow.on?.push?.branches).toEqual(['main']);
  });

  test('cancels a superseded run and holds read-only repository access', () => {
    expect(ci.workflow.concurrency?.['cancel-in-progress']).toBe(true);
    expect(ci.workflow.concurrency?.group).toContain('github.ref');
    expect(ci.workflow.permissions).toEqual({ contents: 'read' });
  });

  test('pins every action to a full commit', () => {
    const used = steps.flatMap((step) => (step.uses ? [step.uses] : []));
    expect(used.length).toBeGreaterThan(0);
    for (const action of used) expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/);
  });

  test('reads no secret and every job has a time limit', () => {
    expect(ci.source).not.toMatch(/secrets\./);
    expect(ci.source).not.toMatch(/docker (?:login|push)|--push/);
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(job['runs-on']).toMatch(/^ubuntu-/);
      expect(job['timeout-minutes']).toBeGreaterThan(0);
    }
  });

  test('installs the pinned Bun with a frozen lockfile', () => {
    const setup = steps.filter((step) => step.uses?.startsWith('oven-sh/setup-bun@'));
    expect(setup.length).toBeGreaterThan(0);
    for (const step of setup) expect(step.with?.['bun-version-file']).toBe('.bun-version');
    // Any version or configuration file an action is pointed at has to be in the tree.
    const pointed = steps.flatMap((step) =>
      Object.entries(step.with ?? {}).flatMap(([key, value]) =>
        key.endsWith('-file') && typeof value === 'string' ? [value] : [],
      ),
    );
    expect(pointed).toContain('.bun-version');
    for (const file of pointed) expect(existsSync(join(root, file))).toBe(true);
    expect(commands).toContain('bun install --frozen-lockfile');
    expect(commands.filter((line) => /^bun install\b/.test(line))).toEqual(
      commands.filter((line) => line === 'bun install --frozen-lockfile'),
    );
  });

  test('every package script it runs exists', () => {
    const named = commands.flatMap((line) => {
      const match = /^bun run ([\w:-]+)$/.exec(line);
      return match?.[1] ? [match[1]] : [];
    });
    for (const script of named) expect(Object.keys(scripts)).toContain(script);
    for (const required of [
      'typecheck',
      'lint',
      'compose:check',
      'browser:compose:check',
      'tailscale:compose:check',
      'doctor',
      'test',
      'test:plugin',
    ])
      expect(named).toContain(required);
  });

  test('the suite runs against a Postgres 17 service that can create databases', () => {
    const suite = jobs.find((job) => job.steps?.some((step) => step.run?.includes('bun run test')));
    const postgres = suite?.services?.postgres;
    expect(postgres?.image).toMatch(/^postgres:17(?:[.-]|$)/);
    // The image's bootstrap role is a superuser, so it can create each disposable database.
    const url = new URL(suite?.env?.DATABASE_URL ?? 'postgres://missing');
    expect(url.username).toBe(postgres?.env?.POSTGRES_USER ?? '');
    expect(url.password).toBe(postgres?.env?.POSTGRES_PASSWORD ?? '');
    expect(url.hostname).toBe('127.0.0.1');
    expect(postgres?.ports).toEqual([`${url.port}:5432`]);
    expect(suite?.steps?.some((step) => step.run?.includes('libpq5'))).toBe(true);
  });

  test('builds every shipped image from a file that exists, without pushing', () => {
    const images = ci.named.find(([name]) => name === 'images')?.[1];
    const builds = (images?.steps ?? [])
      .flatMap((step) => (step.run ?? '').split('\n'))
      .map((line) => line.trim())
      .filter((line) => line.startsWith('docker build '));
    const files = builds.map((line) => / -f (\S+)/.exec(line)?.[1] ?? '');
    expect(files.sort()).toEqual([
      'deploy/Dockerfile.melete',
      'deploy/Dockerfile.web',
      'packages/runtime-hermes/Dockerfile',
    ]);
    for (const line of commands.filter((entry) => entry.startsWith('docker build '))) {
      const file = / -f (\S+)/.exec(line)?.[1] ?? '';
      const context = line.split(' ').at(-1) ?? '';
      expect(existsSync(join(root, file))).toBe(true);
      expect(existsSync(join(root, context))).toBe(true);
    }
  });

  test('a job of its own proves the browser renderer sandbox', () => {
    const [name, job] = ci.named.find(([key]) => key === 'browser-sandbox') ?? [];
    expect(name).toBe('browser-sandbox');
    // Its own job, so a sandbox failure is named and the image builds stay one signal.
    expect(job?.['timeout-minutes']).toBeGreaterThan(0);
    const lines = (job?.steps ?? [])
      .flatMap((step) => (step.run ?? '').split('\n'))
      .map((line) => line.trim());
    expect(lines).toContain(
      'docker build -t melete-browser-sandbox-proof -f deploy/Dockerfile.browser .',
    );
    const proof = (job?.steps ?? []).find((step) => step.env?.MELETE_BROWSER_SANDBOX_PROOF === '1');
    expect(proof?.run).toContain('bun test apps/melete/test/integration/browser-sandbox.test.ts');
    expect(proof?.run).toContain('--max-concurrency=1');
  });

  test('the sandbox job fails rather than skips where the kernel refuses user namespaces', () => {
    const job = ci.named.find(([key]) => key === 'browser-sandbox')?.[1];
    const check = (job?.steps ?? []).find((step) => step.run?.includes('max_user_namespaces'));
    expect(check?.run).toContain('unprivileged_userns_clone');
    // A missing prerequisite ends the job; nothing here may pass quietly.
    expect(check?.run).toContain('exit 1');
    expect(check?.if).toBeUndefined();
    expect(check?.run).toMatch(/::error::/);
  });
});

describe('the browser sandbox proof this workflow runs', () => {
  test('is in the tree and runs on every change, with no step skipped', () => {
    expect(existsSync(join(root, SANDBOX_PROOF))).toBe(true);
    const job = ci.named.find(([key]) => key === 'browser-sandbox')?.[1];
    // Nothing in the job may be skipped: a quiet skip is how the sandbox came to be off before.
    expect((job?.steps ?? []).filter((step) => step.if !== undefined)).toEqual([]);
    expect((job?.steps ?? []).some((step) => step.run?.includes(`bun test ${SANDBOX_PROOF}`))).toBe(
      true,
    );
  });
});

const linesOf = (job?: Job) =>
  (job?.steps ?? []).flatMap((step) => (step.run ?? '').split('\n')).map((line) => line.trim());

describe('the conformance workflow', () => {
  test('runs weekly, on request, and when main changes what it proves', () => {
    expect(conformance.source).not.toBe('');
    expect(conformance.workflow.on).toHaveProperty('workflow_dispatch');
    // The cadence is one line; the pull request lists what the alternatives cost.
    expect(conformance.workflow.on?.schedule).toEqual([{ cron: '0 3 * * 1' }]);
    expect(conformance.workflow.on?.push?.branches).toEqual(['main']);
    expect(conformance.workflow.on?.push?.paths).toEqual([
      'deploy/**',
      'apps/melete/src/**',
      'packages/**',
      'bun.lock',
      'conformance/**',
    ]);
  });

  test('runs on a pull request only when the pull request changes this workflow', () => {
    // Each run builds and starts whole stacks: too much for every pull request.
    expect(conformance.workflow.on?.pull_request).toEqual({
      paths: ['.github/workflows/conformance.yml'],
    });
  });

  test('holds read-only access, never cancels itself, and bounds its time', () => {
    expect(conformance.workflow.permissions).toEqual({ contents: 'read' });
    expect(conformance.workflow.concurrency?.group).toBeTruthy();
    // A second run must wait rather than cancel a stack that is already running.
    expect(conformance.workflow.concurrency?.['cancel-in-progress']).toBe(false);
    expect(conformance.named.map(([name]) => name).sort()).toEqual(['compose', 'upgrade']);
    for (const job of conformance.jobs) {
      expect(job['runs-on']).toMatch(/^ubuntu-/);
      expect(job['timeout-minutes']).toBeGreaterThan(0);
    }
  });

  test('pins every action to a full commit and reads no secret', () => {
    const used = conformance.steps.flatMap((step) => (step.uses ? [step.uses] : []));
    expect(used.length).toBeGreaterThan(0);
    for (const action of used) expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/);
    expect(conformance.source).not.toMatch(/secrets\./);
    expect(conformance.source).not.toMatch(/docker (?:login|push)|git push|--push/);
  });

  test('each job judges the host Docker before it builds or starts a stack', () => {
    for (const [name, job] of conformance.named) {
      const jobSteps = job.steps ?? [];
      const preflight = jobSteps.findIndex((step) =>
        step.run?.includes('deploy/scripts/docker-preflight.ts'),
      );
      const start = jobSteps.findIndex((step) =>
        /docker-compose\.yml (?:up|build)/.test(step.run ?? ''),
      );
      expect([name, preflight > -1 && start > -1 && preflight < start]).toEqual([name, true]);
      // The runner's own versions are printed, so a refusal names the host it refused.
      expect(jobSteps[preflight]?.run).toContain('docker version');
      expect(jobSteps[preflight]?.run).toContain('docker compose version');
    }
  });

  test('each job takes its stack down whatever happened', () => {
    for (const [name, job] of conformance.named) {
      const down = (job.steps ?? []).find((step) => step.run?.includes('down -v'));
      expect([name, down?.if]).toEqual([name, 'always()']);
    }
  });

  test('each job keeps its report and the stack logs when it fails', () => {
    for (const [name, job] of conformance.named) {
      const upload = (job.steps ?? []).find((step) =>
        step.uses?.startsWith('actions/upload-artifact@'),
      );
      expect([name, upload?.if]).toEqual([name, 'failure()']);
      const files = String(upload?.with?.path ?? '')
        .split('\n')
        .map((line) => line.trim().split('/').at(-1) ?? '')
        .filter(Boolean);
      expect(files.length).toBe(2);
      expect(files).toContain('compose-logs.txt');
      // Every file it keeps is one an earlier step of the same job writes.
      for (const file of files)
        expect([name, file, linesOf(job).some((line) => line.includes(file))]).toEqual([
          name,
          file,
          true,
        ]);
    }
  });

  test('the scenario job configures a disposable stack and runs the scenarios', () => {
    const compose = conformance.workflow.jobs?.compose;
    const lines = linesOf(compose);
    expect(lines).toContain('bun run deploy/scripts/configure.ts --fake');
    expect(lines).toContain('bun run compose:check');
    expect(
      lines.some((line) =>
        line.startsWith('docker compose -f deploy/docker-compose.yml up -d --build --wait'),
      ),
    ).toBe(true);
    const scenarios = (compose?.steps ?? []).find(
      (step) => step.env?.MELETE_CONFORMANCE_COMPOSE === '1',
    );
    expect(scenarios?.run).toContain('bun run conformance');
    // A pipe must not swallow a failing run.
    expect(scenarios?.run).toContain('set -o pipefail');
  });

  test('every script, compose file and package script both workflows name exists', () => {
    for (const line of [...commands, ...conformance.commands])
      for (const file of filesNamed([line]))
        expect([line, existsSync(join(root, file))]).toEqual([line, true]);
    const named = conformance.commands.flatMap((line) => {
      // The scenarios are piped through tee, so a named script may carry a pipe after it.
      const match = /^bun run ([\w:-]+)(?: \||$)/.exec(line);
      return match?.[1] ? [match[1]] : [];
    });
    expect(named).toContain('compose:check');
    expect(named).toContain('conformance');
    for (const script of named) expect(Object.keys(scripts)).toContain(script);
  });
});

describe('the upgrade proof', () => {
  const jobSteps = conformance.workflow.jobs?.upgrade?.steps ?? [];
  const find = (text: string) => jobSteps.findIndex((step) => step.run?.includes(text));
  const start = jobSteps.find((step) => step.id === 'start');
  const upgrade = jobSteps.find((step) => step.run?.includes('--repository "$PWD"'));
  const verify = jobSteps.find((step) => step.env?.BEFORE_ID);

  test('has the whole history, so a release tag and the ancestry check can be read', () => {
    const checkout = jobSteps.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.['fetch-depth']).toBe(0);
  });

  test('starts from the newest release tag that has the Compose layout and builds', () => {
    const run = start?.run ?? '';
    expect(run).toContain('set -euo pipefail');
    // A release before this tree, never this tree's own tag.
    expect(run).toContain(
      `git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' "$head^"`,
    );
    expect(run).toContain('git cat-file -e "$start:deploy/docker-compose.yml"');
    expect(run).toContain('git cat-file -e "$start:deploy/scripts/configure.ts"');
    // A start point is configured from nothing and its images built before it is chosen.
    const prepare = /prepare\(\) \{([^}]*)\}/.exec(run)?.[1] ?? '';
    const chain = prepare.split('&&').map((part) => part.trim());
    expect(chain[0]).toStartWith('git -c advice.detachedHead=false checkout --detach "$1"');
    expect(chain).toContain('rm -f deploy/.env');
    expect(chain).toContain('bun run deploy/scripts/configure.ts --fake');
    expect(chain.at(-1)).toBe('docker compose -f deploy/docker-compose.yml build');
    expect(run).toContain('&& prepare "$start"; then');
  });

  test('falls back to the merge base, and says why, when no release will do', () => {
    const run = start?.run ?? '';
    // A tag that does not build is named, so the fallback never hides a broken release.
    expect(run).toMatch(/::warning::.*\$start do not build/);
    expect(run).toContain('git merge-base origin/main "$head"');
    expect(run).toMatch(/::notice::.*starts from \$start on main/);
    // The fallback is prepared outside a condition, so a failure there ends the job.
    expect(run).toMatch(/^ {2}prepare "\$start"$/m);
  });

  test('moves to this tree under a tag the upgrade script accepts', () => {
    const tag = /target="([^"]+)"/.exec(start?.run ?? '')?.[1] ?? '';
    const runId = /\$\{GITHUB_RUN_ID\}/;
    expect(tag).toMatch(runId);
    const concrete = tag.replace(runId, '17893021234');
    expect(parseArguments([concrete], new Date(), '/home/runner', '/repo').tag).toBe(concrete);
    expect(start?.run).toContain('git tag "$target" "$head"');
  });

  test("runs the target release's own upgrade.ts the way docs/UPGRADING.md does", () => {
    const run = upgrade?.run ?? '';
    const archive = 'git archive "$TARGET" | tar -x -C "$RUNNER_TEMP/release"';
    const script =
      'bun run "$RUNNER_TEMP/release/deploy/scripts/upgrade.ts" "$TARGET" --repository "$PWD"';
    expect(run).toContain(archive);
    expect(run).toContain(script);
    expect(run.indexOf(archive)).toBeLessThan(run.indexOf(script));
    // A missing stamp would pass the script's own check, so the copy's stamp is held to the
    // tag's commit before it runs, and the script to saying it read it.
    const stamp =
      /if \[ "\$\(cat "\$RUNNER_TEMP\/release\/deploy\/scripts\/release-commit\.txt"\)" != "\$commit" \]; then\n\s*echo "::error::[^\n]+"\n\s*exit 1\n\s*fi/;
    expect(run).toContain('commit=$(git rev-parse "$TARGET^{commit}")');
    expect(run).toMatch(stamp);
    expect(run.search(stamp)).toBeGreaterThan(run.indexOf(archive));
    expect(run.search(stamp)).toBeLessThan(run.indexOf(script));
    expect(run).toMatch(
      /^grep -Fq "This copy was taken from \$\{commit:0:12\}\." "\$RUNNER_TEMP\/upgrade-report\.txt"$/m,
    );
    // The same two commands an operator is given, with the release directory and the tag.
    const guide = readFileSync(join(root, 'docs/UPGRADING.md'), 'utf8');
    expect(guide).toMatch(/git archive (\S+) \| tar -x -C "\$release"/);
    expect(guide).toMatch(
      /bun run "\$release\/deploy\/scripts\/upgrade\.ts" \S+ --repository "\$PWD"/,
    );
    expect(
      parseArguments(['v0.2.0', '--repository', '/srv/melete'], new Date(), '/h', '/r'),
    ).toMatchObject({ repositoryRoot: '/srv/melete' });
    // Nothing is copied into the installation, so its tree stays clean for the preflight.
    expect(conformance.source).not.toMatch(/bun build|\.git\/info\/exclude/);
    expect(start?.run).toContain('test -z "$(git status --porcelain)"');
  });

  test('writes nothing inside the tree the upgrade checks', () => {
    const run = upgrade?.run ?? '';
    expect(run).toContain('set -o pipefail');
    expect(run).toContain('--backup-dir "$RUNNER_TEMP/backups"');
    expect(run).toMatch(/\| tee "\$RUNNER_TEMP\/upgrade-report\.txt"$/m);
  });

  test('records the internal network before the upgrade and demands the same one after', () => {
    const order = [
      find('docker-compose.yml up -d --build'),
      jobSteps.findIndex((step) => step.id === 'before'),
      upgrade ? jobSteps.indexOf(upgrade) : -1,
      verify ? jobSteps.indexOf(verify) : -1,
    ];
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(verify?.env?.BEFORE_ID).toMatch(/^\$\{\{ steps\.before\.outputs\.id \}\}$/);
    const run = verify?.run ?? '';
    expect(run).toContain('set -euo pipefail');
    expect(run).toContain('"$after" != "$BEFORE_ID"');
    expect(run).toContain('"$attached" != "$BEFORE_ID"');
    expect(run).toContain('::error::');
    expect(run).toContain('exit 1');
  });

  test('the upgraded service answers from the image this tree built', () => {
    const run = verify?.run ?? '';
    expect(run).toContain('test "$(git rev-parse HEAD)" = "$(git rev-parse "$TARGET^{commit}")"');
    expect(run).toContain('melete-service:$TARGET');
    expect(run).toContain('port melete 8787)/health');
    expect(run).toContain(`jq -e '.database == "ok"'`);
  });

  test('a new service image means a new container, and the old image is kept', () => {
    const before = jobSteps.find((step) => step.id === 'before')?.run ?? '';
    expect(before).toContain('echo "container=$service" >> "$GITHUB_OUTPUT"');
    expect(before).toMatch(
      /echo "image=\$\(docker inspect --format '\{\{\.Image\}\}' "\$service"\)"/,
    );
    // The same command upgrade.ts names the preserved images by.
    expect(before).toContain('echo "version=$(git describe --tags --always)"');
    expect(verify?.env?.BEFORE_CONTAINER).toMatch(/steps\.before\.outputs\.container/);
    const run = verify?.run ?? '';
    expect(run).toContain(
      `test "$(docker image inspect --format '{{.Id}}' "melete-service:$BEFORE_VERSION")" = "$BEFORE_IMAGE"`,
    );
    const changed = /if \[ "\$built" != "\$BEFORE_IMAGE" \]; then([\s\S]*?)else([\s\S]*?)fi\n/.exec(
      run,
    );
    expect(changed?.[1]).toContain('if [ "$service" = "$BEFORE_CONTAINER" ]; then');
    expect(changed?.[1]).toContain('::error::');
    expect(changed?.[1]).toContain('exit 1');
    // An unchanged image is said out loud rather than passed as a switch.
    expect(changed?.[2]).toContain('::notice::');
  });
});
