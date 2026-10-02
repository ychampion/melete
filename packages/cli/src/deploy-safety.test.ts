import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDeploy } from './commands/deploy.ts';
import { appendHistory } from './history.ts';
import { temporaryDeployDir } from './testing.ts';
import {
  asLocal,
  type DeployRig,
  deployRig,
  NEW,
  OLD,
  REGISTRY,
  release,
} from './testing-engine.ts';

const short = (commit: string) => commit.slice(0, 7);
const ref = (name: string, tag: string) => `${REGISTRY}/${name}:${tag}`;
const env = (deployDir: string) => readFileSync(join(deployDir, '.env'), 'utf8');

/** The computer image in the registry for both commits, the stack's at OLD, and melete-sandbox:local. */
function withSandbox(rig: DeployRig, localId: string) {
  for (const [tag, commit] of [
    [short(OLD), OLD],
    [short(NEW), NEW],
    ['main', NEW],
  ] as const)
    rig.state.registry.set(ref('melete-sandbox', tag), release('melete-sandbox', commit));
  rig.state.local.set(
    ref('melete-sandbox', 'main'),
    asLocal(ref('melete-sandbox', 'main'), release('melete-sandbox', OLD)),
  );
  rig.state.local.set('melete-sandbox:local', {
    id: localId,
    repoDigests: [],
    layers: [],
    revision: null,
  });
}

describe('what deploy refuses before it acts', () => {
  test('a shell value that differs from deploy/.env refuses the deploy, naming it without its value', async () => {
    const deployDir = temporaryDeployDir();
    const rig = deployRig(deployDir);
    rig.context.environment = { MELETE_IMAGE_TAG: 'v0.9.0', COMPOSE_PROJECT_NAME: 'melete' };
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(2);
    const printed = rig.context.printed();
    expect(printed).toMatch(/fail\s+deploy\.shell\s+This shell sets MELETE_IMAGE_TAG to something/);
    expect(printed).not.toContain('v0.9.0');
    expect(printed).not.toContain('COMPOSE_PROJECT_NAME');
    expect(rig.state.calls).toEqual([]);
    expect(env(deployDir)).toBe(rig.envBefore);
  });

  test('a shell value equal to deploy/.env is no reason to refuse', async () => {
    const deployDir = temporaryDeployDir();
    const rig = deployRig(deployDir);
    rig.context.environment = { MELETE_IMAGE_TAG: 'main', MELETE_IMAGE_REGISTRY: '' };
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(0);
  });

  test('a renamed project with no containers, after deploys of another, is refused', async () => {
    const deployDir = temporaryDeployDir();
    const rig = deployRig(deployDir, { projects: { 'melete-old': ['c0ffee'] } });
    appendHistory(deployDir, {
      at: '2026-10-01T10:00:00.000Z',
      command: 'deploy',
      from: { tag: 'main', revision: OLD },
      to: { tag: 'main', revision: OLD },
      checkout: null,
      migrations: { from: 68, to: 68 },
      project: 'melete-old',
      backup: null,
      result: 'deployed',
      detail: '',
    });
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(2);
    expect(rig.context.printed()).toMatch(
      /fail\s+deploy\.project\s+Compose project melete has no containers, and earlier runs deployed project melete-old/,
    );
    expect(rig.state.pulls).toEqual([]);

    // The same history with the project's containers present is an ordinary deploy.
    rig.state.projects.melete = ['c0ffee'];
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(0);
  });

  test('a full commit sha is deployed by the short tag it is published under', async () => {
    const deployDir = temporaryDeployDir();
    const rig = deployRig(deployDir);
    expect(
      await runDeploy(rig.context, ['--tag', NEW, '--checkout'], false, rig.dependencies),
    ).toBe(0);
    expect(rig.state.pulls).toContain(ref('melete-service', short(NEW)));
    expect(env(deployDir)).toContain(`\nMELETE_IMAGE_TAG=${short(NEW)}\n`);
  });
});

describe('melete-sandbox:local', () => {
  test('follows the published computer image when it was following it already', async () => {
    const deployDir = temporaryDeployDir();
    const rig = deployRig(deployDir, {}, { profiles: ['sandbox'] });
    withSandbox(rig, release('melete-sandbox', OLD).digest);
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(0);
    expect(rig.state.tagged).toEqual([[ref('melete-sandbox', short(NEW)), 'melete-sandbox:local']]);
  });

  test('is left alone when it is an image of its own', async () => {
    const deployDir = temporaryDeployDir();
    const rig = deployRig(deployDir, {}, { profiles: ['sandbox'] });
    withSandbox(rig, 'sha256:built-by-the-operator');
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(0);
    expect(rig.state.tagged).toEqual([]);
    expect(rig.context.printed()).toMatch(
      /warn\s+switch\.sandbox_local\s+melete-sandbox:local is not the published computer image of main/,
    );
  });
});
