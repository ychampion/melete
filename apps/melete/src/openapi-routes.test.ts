/**
 * The published document and the public listener describe the same surface.
 * Every route the owner API serves has an OpenAPI entry, and every entry the
 * listener does not serve is named below with the reason.
 */
import { describe, expect, test } from 'bun:test';
import { buildOpenApiDocument, credentialsRequest, eventDeliveryRequest } from '@melete/contracts';
import { z } from 'zod';
import { credentials } from './api/auth.ts';
import { loadEnv } from './env.ts';
import { type AppDeps, createApp } from './index.ts';
import { eventDelivery } from './jobs/triggers.ts';

/**
 * Documented, but not served by the owner API on port 8787. The owner API lists
 * a person's own actions; reading one, resolving one and the execution claims
 * are answered on the effect listener, which only the runtime network reaches;
 * the attempt reads and space creation have no route.
 */
const DOCUMENTED_ELSEWHERE = [
  'GET /actions/{}',
  'POST /actions/{}/resolve',
  'POST /actions/{}/execution/start',
  'POST /actions/{}/execution/settle',
  'GET /attempts/{}',
  'GET /jobs/{}/attempts',
  'POST /spaces',
];

/** Every route is mounted when its dependency exists; none is called here. */
function servedRoutes(): string[] {
  const stub = new Proxy({}, { get: () => () => undefined }) as never;
  const deps: AppDeps = {
    env: loadEnv({}),
    checkDatabase: async () => 'ok',
    db: stub,
    sql: stub,
    registry: stub,
    jobs: stub,
    triggers: stub,
    approvals: stub,
    events: stub,
    proposer: stub,
    evaluator: stub,
    browserSessions: stub,
    memory: stub,
    removals: stub,
  };
  const routes = createApp(deps)
    .routes.filter((route) => route.method !== 'ALL')
    .map((route) => `${route.method} ${route.path.replace(/:[A-Za-z_]+/g, '{}')}`);
  return [...new Set(routes)].sort();
}

function documentedRoutes(): string[] {
  const paths = (
    buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, unknown>> }
  ).paths;
  return Object.entries(paths)
    .flatMap(([path, operations]) =>
      Object.keys(operations).map(
        (method) => `${method.toUpperCase()} ${path.replace(/\{[^}]+\}/g, '{}')}`,
      ),
    )
    .sort();
}

describe('the published API document', () => {
  const served = servedRoutes();
  const documented = documentedRoutes();

  test('documents every route the owner API serves', () => {
    expect(served.length).toBeGreaterThan(100);
    expect(served.filter((route) => !documented.includes(route))).toEqual([]);
  });

  test('names each documented route the owner API does not serve', () => {
    expect(documented.filter((route) => !served.includes(route))).toEqual(
      [...DOCUMENTED_ELSEWHERE].sort(),
    );
  });

  test('describes the event delivery body the service parses', () => {
    expect(z.toJSONSchema(eventDeliveryRequest)).toEqual(z.toJSONSchema(eventDelivery));
  });
});

describe('the published sign-in body', () => {
  test('is the one setup and sign-in parse', () => {
    // The service lower-cases the email after reading it; what it accepts is the same.
    expect(z.toJSONSchema(credentialsRequest, { io: 'input' }) as unknown).toEqual(
      z.toJSONSchema(credentials, { io: 'input' }),
    );
  });
});
