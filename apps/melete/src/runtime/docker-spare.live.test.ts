/**
 * The runtime image's spare engine on a real Docker engine: it loads with
 * nothing of an attempt, takes one over its port, and serves with the
 * attempt's capability, sooner than an engine started with its attempt.
 * Runs with `MELETE_RUNTIME_LIVE=docker` and the image named by
 * `MELETE_RUNTIME_LIVE_IMAGE` (default `melete-runtime:ci`); never part of an
 * ordinary run. The supervisor's side is covered by docker-spare.test.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { CONTAINER_ATTEMPT_KEYS, SPARE_HANDOFF_PATH } from './docker.ts';

const live = process.env.MELETE_RUNTIME_LIVE === 'docker';
const image = process.env.MELETE_RUNTIME_LIVE_IMAGE ?? 'melete-runtime:ci';
const started: string[] = [];

async function docker(args: string[]): Promise<string> {
  const child = Bun.spawn(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`docker ${args[0]} failed: ${err.trim()}`);
  return out.trim();
}

/** The attempt container's own limits, as the supervisor starts it, on the default bridge. */
async function run(name: string, environment: Record<string, string>) {
  started.push(name);
  await docker([
    'run',
    '--detach',
    '--name',
    name,
    '--read-only',
    '--user',
    '10001:10001',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--tmpfs',
    '/tmp:rw,size=64m,mode=1777',
    '--tmpfs',
    '/var/lib/hermes:rw,size=64m,uid=10001,gid=10001,mode=0700',
    '--tmpfs',
    '/work:rw,size=16m,uid=10001,gid=10001,mode=0770',
    ...Object.entries(environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    image,
  ]);
  const address = await docker(['inspect', '--format', '{{.NetworkSettings.IPAddress}}', name]);
  return `http://${address}:8790`;
}

async function until(
  url: string,
  key: string,
  ok: (status: number) => boolean,
  name: string,
): Promise<number> {
  const from = Date.now();
  while (Date.now() - from < 180_000) {
    try {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(2000),
      });
      await response.body?.cancel();
      if (ok(response.status)) return Date.now() - from;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error(`${name} did not answer: ${await docker(['logs', '--tail', '40', name])}`);
}

const base = (key: string) => ({
  HERMES_HOME: '/var/lib/hermes',
  API_SERVER_KEY: key,
  MELETE_BROKER_URL: 'http://melete:8788',
  MELETE_MODEL_PROVIDER: 'fireworks',
  MELETE_MODEL_NAME: 'accounts/fireworks/models/deepseek-v4p1-flash',
  MELETE_MODEL_API_MODE: 'chat_completions',
});
const attempt = (suffix: string) => ({
  MELETE_ATTEMPT_TOKEN: `live-capability-${suffix}`,
  MELETE_ATTEMPT_ID: `att_01J000000000000000000000${suffix}`,
  MELETE_JOB_ID: `job_01J000000000000000000000${suffix}`,
  MELETE_MODEL_KEY: `melete-surrogate-att_01J000000000000000000000${suffix}`,
  HERMES_TIMEZONE: 'Europe/Paris',
});

afterAll(async () => {
  for (const name of started) await docker(['rm', '--force', name]).catch(() => {});
});

describe.skipIf(!live)('the runtime image on a real engine', () => {
  test('a spare loads without its attempt, takes it over its port, and serves sooner', async () => {
    const suffix = String(process.pid % 100).padStart(2, '0');
    const coldKey = 'c'.repeat(64);
    const coldName = `melete-live-cold-${suffix}`;
    const coldAt = Date.now();
    const coldUrl = await run(coldName, { ...base(coldKey), ...attempt('C1') });
    await until(`${coldUrl}/v1/capabilities`, coldKey, (s) => s === 200, coldName);
    const coldMs = Date.now() - coldAt;

    const spareKey = 's'.repeat(64);
    const spareName = `melete-live-spare-${suffix}`;
    const spareAt = Date.now();
    const spareUrl = await run(spareName, {
      ...base(spareKey),
      MELETE_RUNTIME_SPARE: '1',
      MELETE_RUNTIME_SPARE_KEYS: CONTAINER_ATTEMPT_KEYS.join(','),
    });
    // Loaded: the handoff path answers. The engine's own API does not, yet.
    await until(`${spareUrl}${SPARE_HANDOFF_PATH}`, spareKey, (s) => s === 200, spareName);
    const loadMs = Date.now() - spareAt;
    const capabilities = await fetch(`${spareUrl}/v1/capabilities`, {
      headers: { authorization: `Bearer ${spareKey}` },
    });
    expect(capabilities.status).not.toBe(200);
    const wrong = await fetch(`${spareUrl}${SPARE_HANDOFF_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${'w'.repeat(64)}` },
      body: '{}',
    });
    expect(wrong.status).toBe(401);
    const inspected = await docker(['inspect', '--format', '{{json .Config.Env}}', spareName]);
    expect(inspected).not.toContain('live-capability');
    for (const key of CONTAINER_ATTEMPT_KEYS) expect(inspected).not.toContain(`"${key}=`);

    const handedAt = Date.now();
    const handoff = await fetch(`${spareUrl}${SPARE_HANDOFF_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${spareKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/work', env: attempt('S1') }),
    });
    expect(handoff.status).toBe(204);
    await until(`${spareUrl}/v1/capabilities`, spareKey, (s) => s === 200, spareName);
    const handoffMs = Date.now() - handedAt;
    const config = await docker(['exec', spareName, 'cat', '/var/lib/hermes/config.yaml']);
    expect(config).toContain('x-melete-capability: live-capability-S1');
    const logs = await docker(['logs', spareName]);
    expect(logs).not.toContain('melete-spare:unusable');
    process.stdout.write(
      `engine ready: started with its attempt ${coldMs} ms; spare loaded in ${loadMs} ms, ` +
        `then ready ${handoffMs} ms after its handoff\n`,
    );
    expect(handoffMs).toBeLessThan(coldMs);
  }, 400_000);
});
