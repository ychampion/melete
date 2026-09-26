import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { type AttemptBundle, EMPTY_SINCE_LAST } from '@melete/contracts';
import {
  brokerCatalogState,
  DEFAULT_COMPACTION_MAX_TOKENS,
  DEFAULT_ENGINE_MAX_TURNS,
} from '@melete/runtime-hermes';
import { parse } from 'yaml';
import { brokerUrlForBind, demonstrationWarnings, envSchema, loadEnv, readEnv } from './env.ts';

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

/** The shape deploy/scripts/configure.ts writes. */
const GENERATED_DATABASE_URL = `postgres://melete:${'0f'.repeat(24)}@postgres:5432/melete`;

/** The environment Compose would hand the service, with every placeholder filled in. */
function composeServiceEnvironment(): Record<string, string> {
  const compose = parse(
    readFileSync(join(import.meta.dir, '../../../deploy/docker-compose.yml'), 'utf8'),
  ) as { services: { melete: { environment: Record<string, string | number | boolean> } } };
  return Object.fromEntries(
    Object.entries(compose.services.melete.environment).map(([key, value]) => [
      key,
      String(value).replace(/\$\{[A-Z0-9_]+:([-?])([^}]*)\}/g, (_match, kind, fallback) =>
        kind === '-' ? fallback : key === 'DATABASE_URL' ? GENERATED_DATABASE_URL : 'x'.repeat(64),
      ),
    ]),
  );
}

describe('the model defaults', () => {
  test('the default model is the identifier its provider serves', () => {
    const env = loadEnv({});
    expect(env.MELETE_DEFAULT_PROVIDER).toBe('fireworks');
    expect(env.MELETE_DEFAULT_MODEL).toBe('accounts/fireworks/models/deepseek-v4p1-flash');
  });

  test('the example configuration selects the same model as the service default', () => {
    const example = readFileSync(
      join(import.meta.dir, '../../../deploy/.env.example'),
      'utf8',
    ).split(/\r?\n/);
    expect(example).toContain(`MELETE_DEFAULT_MODEL=${loadEnv({}).MELETE_DEFAULT_MODEL}`);
    expect(example).toContain(
      `MELETE_DEFAULT_MAX_OUTPUT_TOKENS=${loadEnv({}).MELETE_DEFAULT_MAX_OUTPUT_TOKENS}`,
    );
  });

  test('the output limit for a request that names none is 4,096 and can be changed', () => {
    expect(loadEnv({}).MELETE_DEFAULT_MAX_OUTPUT_TOKENS).toBe(4096);
    expect(
      loadEnv({ MELETE_DEFAULT_MAX_OUTPUT_TOKENS: '2048' }).MELETE_DEFAULT_MAX_OUTPUT_TOKENS,
    ).toBe(2048);
    for (const value of ['0', '-1', '1.5', 'many'])
      expect(readEnv({ MELETE_DEFAULT_MAX_OUTPUT_TOKENS: value }).ok).toBe(false);
  });

  test('Compose falls back to the same provider and model as the service and the example', () => {
    // Only a deploy/.env without these lines meets the fallback; it must not
    // select a provider the service then refuses to start with.
    const composed = composeServiceEnvironment();
    const env = loadEnv({});
    expect(composed.MELETE_DEFAULT_PROVIDER).toBe(env.MELETE_DEFAULT_PROVIDER);
    expect(composed.MELETE_DEFAULT_MODEL).toBe(env.MELETE_DEFAULT_MODEL);
    const example = readFileSync(join(import.meta.dir, '../../../deploy/.env.example'), 'utf8');
    expect(example).toContain(`\nMELETE_DEFAULT_PROVIDER=${env.MELETE_DEFAULT_PROVIDER}\n`);
    const runtime = readFileSync(
      join(import.meta.dir, '../../../deploy/docker-compose.yml'),
      'utf8',
    );
    expect(runtime).toContain(
      `MELETE_MODEL_PROVIDER: \${MELETE_DEFAULT_PROVIDER:-${env.MELETE_DEFAULT_PROVIDER}}`,
    );
    expect(runtime).toContain(
      `MELETE_MODEL_NAME: \${MELETE_DEFAULT_MODEL:-${env.MELETE_DEFAULT_MODEL}}`,
    );
  });

  test('Compose passes the output limit through to the service', () => {
    expect(composeServiceEnvironment().MELETE_DEFAULT_MAX_OUTPUT_TOKENS).toBe('4096');
  });

  test('every service setting the example configuration lists reaches the service', () => {
    // Compose hands a container only the variables its file names, so a setting
    // written in deploy/.env and missing there is silently ignored.
    const example = readFileSync(join(import.meta.dir, '../../../deploy/.env.example'), 'utf8');
    const listed = [...example.matchAll(/^([A-Z_][A-Z0-9_]*)=/gm)].map((match) => match[1] ?? '');
    const read = Object.keys(envSchema.in.shape);
    const composed = composeServiceEnvironment();
    expect(listed).toContain('MELETE_ENGINE_MAX_TURNS');
    expect(listed.filter((name) => read.includes(name) && !(name in composed))).toEqual([]);
  });
});

describe('the engine limits', () => {
  test('a malformed engine limit stops the service instead of every attempt', () => {
    // These are read again when an attempt starts, which is where they are
    // applied. If the only reading were there, a typo would let the service boot
    // healthy and then fail each attempt at launch, one at a time, for as long
    // as nobody looked at the environment.
    for (const name of [
      'MELETE_ENGINE_MAX_TURNS',
      'MELETE_COMPACTION_MAX_TOKENS',
      'MELETE_MODEL_CONTEXT_WINDOW',
    ]) {
      for (const value of ['0', '-1', '1.5', 'many'])
        expect(readEnv({ [name]: value }).ok).toBe(false);
      expect(readEnv({ [name]: '64000' }).ok).toBe(true);
    }
  });

  test('Compose passes each limit through, and an empty one keeps the default', () => {
    const composed = composeServiceEnvironment();
    for (const name of [
      'MELETE_ENGINE_MAX_TURNS',
      'MELETE_COMPACTION_MAX_TOKENS',
      'MELETE_MODEL_CONTEXT_WINDOW',
    ])
      expect(composed[name]).toBe('');
    const env = loadEnv(composed);
    expect(env.MELETE_ENGINE_MAX_TURNS).toBe(DEFAULT_ENGINE_MAX_TURNS);
    expect(env.MELETE_COMPACTION_MAX_TOKENS).toBe(DEFAULT_COMPACTION_MAX_TOKENS);
    expect(env.MELETE_MODEL_CONTEXT_WINDOW).toBeUndefined();
    expect(env.MELETE_PUBLIC_URL).toBeUndefined();
  });

  test('the defaults are the ones the engine configuration renders', () => {
    const env = loadEnv({});
    expect(env.MELETE_ENGINE_MAX_TURNS).toBe(DEFAULT_ENGINE_MAX_TURNS);
    expect(env.MELETE_COMPACTION_MAX_TOKENS).toBe(DEFAULT_COMPACTION_MAX_TOKENS);
    expect(env.MELETE_MODEL_CONTEXT_WINDOW).toBeUndefined();
  });
});

describe('the database address', () => {
  test('one the Postgres client cannot read stops start-up by name, without its password', () => {
    for (const value of [
      'postgres://melete:hunter2-secret@postgres:54x2/melete',
      'postgres://melete:hunter2-secret%zz@postgres:5432/melete',
      'melete:hunter2-secret@postgres:5432/melete',
      'mysql://melete:hunter2-secret@postgres/melete',
      'MongoDB+srv://melete:hunter2-secret@postgres/melete',
    ]) {
      const result = readEnv({ DATABASE_URL: value });
      expect(result.ok).toBe(false);
      const issues = result.ok ? '' : result.issues.join('\n');
      expect(issues).toStartWith('DATABASE_URL: ');
      expect(issues).not.toContain('hunter2');
    }
  });

  test('the addresses the client reads are kept as written', () => {
    for (const value of [
      GENERATED_DATABASE_URL,
      'postgres://melete:p%40ss@postgres:5432/melete',
      'postgresql://melete:secret@db-a:5432,db-b:5433/melete?sslmode=require',
      'postgres://melete:secret@[::1]:5432/melete',
      'postgres:///melete?host=/var/run/postgresql',
      // The client ignores the scheme's name and case, and leading whitespace.
      'POSTGRES://melete:secret@postgres:5432/melete',
      'pg://melete:secret@postgres:5432/melete',
      ' postgres://melete:secret@postgres:5432/melete',
    ]) {
      const result = readEnv({ DATABASE_URL: value });
      expect(result.ok && result.env.DATABASE_URL).toBe(value);
    }
  });
});

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

describe('demonstration settings beside a real provider', () => {
  test('the test connector on beside a real provider is warned about at start-up', () => {
    const warnings = demonstrationWarnings(
      loadEnv({ MELETE_ENABLE_TEST_CONNECTOR: 'true', MELETE_DEFAULT_PROVIDER: 'anthropic' }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('MELETE_ENABLE_TEST_CONNECTOR=true');
    expect(warnings[0]).toContain('anthropic');
  });

  test('the scripted provider on beside a real provider is warned about too', () => {
    const warnings = demonstrationWarnings(
      loadEnv({ MELETE_ENABLE_FAKE_PROVIDER: 'true', MELETE_DEFAULT_PROVIDER: 'anthropic' }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('MELETE_ENABLE_FAKE_PROVIDER=true');
  });

  test('the demonstration itself, and a production configuration, are quiet', () => {
    expect(
      demonstrationWarnings(
        loadEnv({
          MELETE_ENABLE_TEST_CONNECTOR: 'true',
          MELETE_ENABLE_FAKE_PROVIDER: 'true',
          MELETE_DEFAULT_PROVIDER: 'fake',
        }),
      ),
    ).toEqual([]);
    expect(demonstrationWarnings(loadEnv({ MELETE_DEFAULT_PROVIDER: 'anthropic' }))).toEqual([]);
  });
});
