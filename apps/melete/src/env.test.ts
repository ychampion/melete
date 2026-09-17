import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { type AttemptBundle, EMPTY_SINCE_LAST } from '@melete/contracts';
import { brokerCatalogState } from '@melete/runtime-hermes';
import { parse } from 'yaml';
import { brokerUrlForBind, loadEnv, readEnv } from './env.ts';

const bundle: AttemptBundle = {
  attempt: {
    id: 'att_01J00000000000000000000000',
    job_id: 'job_01J00000000000000000000000',
    epoch: 1,
    revision: 0,
    token: 'only-this-attempt',
  },
  job: {
    title: 'Read the catalog',
    objective: 'Reach the broker this service bound',
    constraints: {},
    progress_summary: '',
    unresolved_questions: [],
    deliverable: {},
  },
  since_last: EMPTY_SINCE_LAST,
  inputs: { new_user_messages: [], approval_results: [], trigger_events: [], repair_briefs: [] },
  transcript: [],
  tools: [],
  skills: [],
  knowledge: [],
  workspace: { mount: '/work', files: [] },
  budget: { max_turns: 1, max_output_tokens: 100, max_wall_ms: 10000, max_actions: 1 },
  model: { provider: 'fake', model: 'scripted', fallback: null },
};

const unusedPort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(new Error('port')),
      );
    });
  });

/** The environment Compose would hand the service, with every placeholder filled in. */
function composeServiceEnvironment(): Record<string, string> {
  const compose = parse(
    readFileSync(join(import.meta.dir, '../../../deploy/docker-compose.yml'), 'utf8'),
  ) as { services: { melete: { environment: Record<string, string | number | boolean> } } };
  return Object.fromEntries(
    Object.entries(compose.services.melete.environment).map(([key, value]) => [
      key,
      String(value).replace(/\$\{[A-Z_]+:([-?])([^}]*)\}/g, (_match, kind, fallback) =>
        kind === '-' ? fallback : 'x'.repeat(64),
      ),
    ]),
  );
}

describe('the address the service reads its own tool catalog from', () => {
  test('follows the bound broker when only the bind is configured', () => {
    expect(loadEnv({}).MELETE_BROKER_URL).toBe('http://127.0.0.1:3112');
    expect(loadEnv({ MELETE_BROKER_BIND: '0.0.0.0:8788' }).MELETE_BROKER_URL).toBe(
      'http://127.0.0.1:8788',
    );
    expect(loadEnv({ MELETE_BROKER_BIND: '127.0.0.1:3172' }).MELETE_BROKER_URL).toBe(
      'http://127.0.0.1:3172',
    );
  });

  test('a wildcard bind is reached over loopback and a named bind by its name', () => {
    expect(brokerUrlForBind('[::]:8788')).toBe('http://[::1]:8788');
    expect(brokerUrlForBind('[::1]:9000')).toBe('http://[::1]:9000');
    expect(brokerUrlForBind('broker.internal:8788')).toBe('http://broker.internal:8788');
    expect(brokerUrlForBind('0.0.0.0')).toBeNull();
    expect(brokerUrlForBind('0.0.0.0:0')).toBeNull();
    expect(brokerUrlForBind('0.0.0.0:70000')).toBeNull();
  });

  test('a catalog request reaches a broker bound to every interface', async () => {
    const port = await unusedPort();
    const requests: string[] = [];
    const broker = Bun.serve({
      hostname: '127.0.0.1',
      port,
      fetch: (request) => {
        requests.push(new URL(request.url).pathname);
        return Response.json({ tools: [] });
      },
    });
    try {
      const env = loadEnv({ MELETE_BROKER_BIND: `0.0.0.0:${port}` });
      expect(await brokerCatalogState({ brokerUrl: env.MELETE_BROKER_URL })(bundle)).toEqual([]);
      expect(requests).toEqual(['/tools']);
    } finally {
      await broker.stop(true);
    }
  });

  test('the shipped Compose environment targets the port its broker binds', () => {
    const source = composeServiceEnvironment();
    const env = loadEnv(source);
    expect(env.MELETE_BROKER_BIND).toBe('0.0.0.0:8788');
    expect(new URL(env.MELETE_BROKER_URL).port).toBe('8788');
  });

  test('an explicit address on another port stops the service at start-up', () => {
    const result = readEnv({
      MELETE_BROKER_BIND: '0.0.0.0:8788',
      MELETE_BROKER_URL: 'http://127.0.0.1:3112',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join('\n')).toContain('MELETE_BROKER_URL');
      expect(result.issues.join('\n')).toContain('MELETE_BROKER_BIND');
      expect(result.issues.join('\n')).toContain('8788');
    }
  });

  test('a loopback listener cannot be addressed by another name, nor the reverse', () => {
    expect(
      readEnv({ MELETE_BROKER_BIND: '127.0.0.1:8788', MELETE_BROKER_URL: 'http://melete:8788' }).ok,
    ).toBe(false);
    expect(
      readEnv({ MELETE_BROKER_BIND: '10.0.0.4:8788', MELETE_BROKER_URL: 'http://127.0.0.1:8788' })
        .ok,
    ).toBe(false);
  });

  test('an explicit address that can reach the listener is kept as written', () => {
    expect(
      loadEnv({ MELETE_BROKER_BIND: '0.0.0.0:8788', MELETE_BROKER_URL: 'http://melete:8788' })
        .MELETE_BROKER_URL,
    ).toBe('http://melete:8788');
    expect(
      loadEnv({ MELETE_BROKER_BIND: '127.0.0.1:3172', MELETE_BROKER_URL: 'http://localhost:3172' })
        .MELETE_BROKER_URL,
    ).toBe('http://localhost:3172');
  });

  test('a bind that is not host:port is refused before anything listens', () => {
    const result = readEnv({ MELETE_BROKER_BIND: 'not-an-address' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join('\n')).toContain('MELETE_BROKER_BIND');
  });
});
