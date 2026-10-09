/**
 * The image publishing workflow runs only on main, on release tags and by hand,
 * so what it promises is checked here on every pull request: which images it
 * builds and from what, that nothing is pushed from a pull request, that the
 * moving tags wait for all five images, and that it holds no credential but
 * the job's own token.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { loadCompose } from './compose-check.ts';

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
};
type Job = {
  needs?: string | string[];
  if?: string;
  'runs-on'?: string;
  'timeout-minutes'?: number;
  permissions?: Record<string, string>;
  strategy?: { matrix?: { include?: Record<string, string>[] } };
  steps?: Step[];
};
type Workflow = {
  on?: {
    push?: { branches?: string[]; tags?: string[] };
    pull_request?: { paths?: string[] };
    workflow_dispatch?: unknown;
  };
  permissions?: Record<string, string>;
  jobs?: Record<string, Job>;
};

const root = fileURLToPath(new URL('../..', import.meta.url));
const PATH = '.github/workflows/images.yml';
const source = readFileSync(join(root, PATH), 'utf8');
const workflow = parse(source) as Workflow;
const jobs = workflow.jobs ?? {};
const steps = Object.values(jobs).flatMap((job) => job.steps ?? []);
const build = jobs.build;
const buildStep = build?.steps?.find((step) => step.uses?.startsWith('docker/build-push-action@'));

describe('the image publishing workflow', () => {
  test('publishes from main and release tags, by hand, and dry-runs its own changes', () => {
    expect(workflow.on?.push?.branches).toEqual(['main']);
    expect(workflow.on?.push?.tags).toEqual(['v*']);
    expect(workflow.on).toHaveProperty('workflow_dispatch');
    expect(workflow.on?.pull_request?.paths).toEqual([PATH]);
  });

  test('pins every action to a full commit', () => {
    const used = steps.flatMap((step) => (step.uses ? [step.uses] : []));
    expect(used.length).toBeGreaterThan(0);
    for (const action of used) expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/);
  });

  test('writes packages only from the jobs that push, with the job token alone', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    for (const [name, job] of Object.entries(jobs)) {
      expect(job['runs-on']).toMatch(/^ubuntu-/);
      expect(job['timeout-minutes']).toBeGreaterThan(0);
      if (job.permissions?.packages === 'write') expect(['build', 'publish']).toContain(name);
    }
    expect(source.match(/secrets\.\w+/g)?.every((use) => use === 'secrets.GITHUB_TOKEN')).toBe(
      true,
    );
  });

  test('builds the five shipped images for linux/amd64 from files that exist', () => {
    const matrix = build?.strategy?.matrix?.include ?? [];
    expect(matrix.map((entry) => entry.image).sort()).toEqual([
      'melete-browser',
      'melete-runtime',
      'melete-sandbox',
      'melete-service',
      'melete-web',
    ]);
    const files = Object.fromEntries(matrix.map((entry) => [entry.image, entry.file]));
    expect(files).toEqual({
      'melete-service': 'deploy/Dockerfile.melete',
      'melete-web': 'deploy/Dockerfile.web',
      'melete-runtime': 'packages/runtime-hermes/Dockerfile',
      'melete-sandbox': 'deploy/Dockerfile.sandbox',
      'melete-browser': 'deploy/Dockerfile.browser',
    });
    for (const entry of matrix) {
      expect(existsSync(join(root, entry.file ?? ''))).toBe(true);
      expect(existsSync(join(root, entry.context ?? ''))).toBe(true);
    }
    // The runtime builds from its own directory, as Compose builds it.
    const runtime = loadCompose(join(root, 'deploy/docker-compose.yml')).services?.[
      'runtime-image'
    ] as { build?: { context?: string } } | undefined;
    expect(runtime?.build?.context).toBe('../packages/runtime-hermes');
    expect(matrix.find((entry) => entry.image === 'melete-runtime')?.context).toBe(
      'packages/runtime-hermes',
    );
    expect(buildStep?.with?.platforms).toBe('linux/amd64');
  });

  test('checks the plugin pin before building, and never pushes from a pull request', () => {
    expect(build?.needs).toBe('check');
    expect(jobs.check?.steps?.some((step) => step.run === 'bun run compose:check')).toBe(true);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: an Actions expression, not a template.
    expect(buildStep?.with?.push).toBe("${{ github.event_name != 'pull_request' }}");
    const login = build?.steps?.find((step) => step.uses?.startsWith('docker/login-action@'));
    expect(login?.if).toBe("github.event_name != 'pull_request'");
  });

  test('labels each image with its source and commit, and caches layers in Actions', () => {
    const labels = String(buildStep?.with?.labels ?? '');
    expect(labels).toContain('org.opencontainers.image.source=');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: an Actions expression, not a template.
    expect(labels).toContain('org.opencontainers.image.revision=${{ github.sha }}');
    expect(String(buildStep?.with?.['cache-from'])).toStartWith('type=gha');
    expect(String(buildStep?.with?.['cache-to'])).toStartWith('type=gha');
  });

  test('pushes under the commit, and moves main or the version only after all five', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: an Actions expression, not a template.
    expect(String(buildStep?.with?.tags)).toBe('${{ steps.name.outputs.ref }}');
    const naming = build?.steps?.find((step) => step.run?.includes('GITHUB_OUTPUT'))?.run ?? '';
    // biome-ignore lint/suspicious/noTemplateCurlyInString: an Actions expression, not a template.
    expect(naming).toContain('ghcr.io/${owner}/${{ matrix.image }}:${GITHUB_SHA::7}');
    const publish = jobs.publish;
    expect(publish?.needs).toBe('build');
    expect(publish?.if).toBe(
      "github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v')",
    );
    const run = publish?.steps?.map((step) => step.run ?? '').join('\n') ?? '';
    expect(run).toContain('docker buildx imagetools create');
    expect(run).toContain(
      'for image in melete-service melete-web melete-runtime melete-sandbox melete-browser;',
    );
  });
});
