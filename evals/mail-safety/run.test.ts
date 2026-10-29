import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import corpus from './corpus.json' with { type: 'json' };
import { corpusHash, type Manifest, sha256 } from './generate.ts';
import {
  type Config,
  type HardGuard,
  main,
  nextAttempt,
  requireSettlement,
  runCampaign,
} from './run.ts';

test('a third smoke item is refused across attempts, including failures', () => {
  expect(() => nextAttempt({ attempts: [{ id: 'a' }, { id: 'b' }] }, 'c', 2)).toThrow('two');
});

test('resume reconciles the same submission instead of posting again', () => {
  const old = { id: 'a', submissionId: 'stable-1', phase: 'submitted', reservation: 'hold-1' };
  expect(nextAttempt({ attempts: [old] }, 'a', 2)).toEqual({ attempt: old, resume: true });
  expect(() => nextAttempt({ attempts: [old] }, 'b', 2)).toThrow('unsettled');
});

test('missing cost, settlement or actual Nemotron identity is refused', () => {
  const row = {
    id: 'u1',
    jobId: 'job',
    provider: 'nebius',
    requestedModel: 'nvidia/Nemotron-3.5-Super-VL',
    actualModel: 'nvidia/Nemotron-3.5-Super-VL',
    usageEstimated: true,
    inputTokens: 10,
    cachedTokens: 0,
    outputTokens: 2,
    costUsd: 0.01,
    usageClass: 'interactive',
  };
  expect(() => requireSettlement({ settled: true, usage: [row] }, true)).not.toThrow();
  for (const patch of [
    { settled: false },
    { usage: [] },
    { usage: [{ ...row, costUsd: null }] },
    { usage: [{ ...row, actualModel: null }] },
    { usage: [{ ...row, actualModel: 'another-model' }] },
  ])
    expect(() => requireSettlement({ settled: true, usage: [row], ...patch }, true)).toThrow();
});

async function manifestAt(directory: string) {
  const manifest: Manifest = {
    version: 1,
    corpusHash: corpusHash(),
    seed: 20261029,
    date: corpus.date,
    renderer: 'scorer fixture',
    fontHash: 'fixture',
    items: [],
  };
  for (const c of corpus.cases) {
    const file = `${c.id}.${c.format === 'image' ? 'png' : 'eml'}`;
    const bytes = new Uint8Array([1, 2, 3]);
    await Bun.write(join(directory, file), bytes);
    manifest.items.push({
      id: c.id,
      file,
      format: c.format,
      sha256: sha256(bytes),
      scorer: c.scorer,
    });
  }
  await Bun.write(join(directory, 'manifest.json'), JSON.stringify(manifest));
}

test('run refuses a missing external hard guard before network', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mail-guard-'));
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    calls++;
    throw new Error('network');
  }) as unknown as typeof fetch;
  try {
    await Bun.write(join(dir, 'config.json'), '{}');
    await expect(
      main([
        'run',
        '--config',
        join(dir, 'config.json'),
        '--limit',
        '2',
        '--budget-usd',
        '0.1',
        '--out',
        join(dir, 'run'),
      ]),
    ).rejects.toThrow('hard guard');
    expect(calls).toBe(0);
  } finally {
    globalThis.fetch = original;
    await rm(dir, { recursive: true, force: true });
  }
});

test('successful dry-run and regrade make zero network calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mail-offline-'));
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('network forbidden');
  }) as unknown as typeof fetch;
  try {
    await manifestAt(dir);
    await main(['dry-run', '--corpus', dir]);
    await Bun.write(
      join(dir, 'run.json'),
      JSON.stringify({ version: 1, corpusHash: corpusHash(), observations: [] }),
    );
    await main(['regrade', '--in', join(dir, 'run.json'), '--out', join(dir, 'result')]);
    expect(await Bun.file(join(dir, 'result', 'report.json')).exists()).toBe(true);
    await expect(
      main(['regrade', '--in', join(dir, 'run.json'), '--out', join(dir, 'result')]),
    ).rejects.toThrow();
  } finally {
    globalThis.fetch = original;
    await rm(dir, { recursive: true, force: true });
  }
});

test('a lost submission reply checkpoints failure and resume reconciles without a second POST', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mail-resume-'));
  const original = globalThis.fetch;
  const refs = ['MAIL_FIXTURE_OWNER', 'MAIL_FIXTURE_HELPER', 'MAIL_FIXTURE_OUTSIDER'];
  const old = refs.map((key) => process.env[key]);
  refs.forEach((key, i) => {
    process.env[key] = `fixture-${i}`;
  });
  const c = corpus.cases.find((c) => c.format === 'image')!;
  let posts = 0;
  let reservations = 0;
  let reconciles = 0;
  let pending = 0;
  const config: Config = {
    version: 1,
    disposable: true,
    targetId: 'fixture-target',
    campaignId: 'fixture-campaign',
    baseUrl: 'https://app.example.test',
    corpusHash: corpusHash(),
    corpusDir: dir,
    requireNemotron: false,
    accounts: {
      owner: { id: 'owner-1', sessionRef: refs[0]! },
      helper: { id: 'helper-1', sessionRef: refs[1]! },
      outsider: { id: 'outsider-1', sessionRef: refs[2]! },
    },
    cases: {
      [c.id]: {
        roomId: 'room-1',
        helperLabel: 'Room helper',
        helperConsent: true,
        ledgerFile: join(dir, 'ledger.json'),
      },
    },
  };
  const guard: HardGuard = {
    verify: async () => ({
      proofId: 'scripted-proof',
      targetId: config.targetId,
      campaignId: config.campaignId,
      capUsd: 0.1,
      maxItems: 2,
      covers: ['foreground', 'background', 'retry', 'secondary'],
      pending,
    }),
    reserve: async () => {
      reservations++;
      pending = 1;
      return { receiptId: 'hold-1' };
    },
    reconcile: async () => {
      reconciles++;
      return {
        receiptId: 'hold-1',
        settled: true,
        costUsd: 0,
        submission: { threadId: 'thread-1', jobId: 'job-1' },
      };
    },
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const req = input as Request;
    const path = new URL(req.url).pathname;
    const who = req.headers.get('cookie');
    if (path === '/me')
      return Response.json({
        owner: {
          id: who === 'fixture-0' ? 'owner-1' : who === 'fixture-1' ? 'helper-1' : 'outsider-1',
        },
      });
    if (who === 'fixture-2') return new Response('{}', { status: 404 });
    if (path.endsWith('/attachments')) return Response.json({ attachment: { id: 'file-1' } });
    if (path.endsWith('/threads') && req.method === 'POST') {
      posts++;
      throw new Error('lost acknowledgement');
    }
    if (path === '/rooms/room-1')
      return Response.json({
        room: { my_role: 'owner' },
        policy: { agent_turns: 'asked' },
        members: [{ principal_id: 'helper-1', role: 'member', display_name: 'Room helper' }],
      });
    if (path.endsWith('/summaries-only')) return Response.json({ on: true });
    if (path.endsWith('/board')) return Response.json({ items: [] });
    if (path.endsWith('/memory')) return Response.json({ items: [], shares: [] });
    if (path.endsWith('/threads')) return Response.json({ threads: [] });
    if (path.endsWith('/events'))
      return req.headers.get('accept') === 'text/event-stream'
        ? new Response('', { headers: { 'content-type': 'text/event-stream' } })
        : Response.json({ frames: [], next_cursor: 0 });
    return Response.json({
      requests: [
        {
          job_id: 'job-1',
          status: 'done',
          turns: [{ answer: 'Verdict: looks genuine' }],
          cards: [],
          receipts: [],
        },
      ],
    });
  }) as unknown as typeof fetch;
  try {
    await manifestAt(dir);
    await Bun.write(
      join(dir, 'ledger.json'),
      JSON.stringify({
        version: 1,
        targetId: config.targetId,
        roomId: 'room-1',
        submissionId: `mail-${c.id}`,
        jobIds: ['job-1'],
        pending: 0,
        settled: true,
        usage: [
          {
            id: 'usage-1',
            jobId: 'job-1',
            provider: 'fake',
            requestedModel: 'scripted',
            actualModel: 'scripted',
            usageEstimated: false,
            inputTokens: 1,
            cachedTokens: 0,
            outputTokens: 1,
            costUsd: 0,
            usageClass: 'interactive',
          },
        ],
      }),
    );
    await expect(runCampaign(config, join(dir, 'run'), 1, 0.1, guard)).rejects.toThrow(
      'lost acknowledgement',
    );
    const partial = (await Bun.file(join(dir, 'run', 'run.json')).json()) as {
      observations: unknown[];
      pending: string[];
    };
    expect(partial.observations).toHaveLength(1);
    expect(partial.pending).toEqual([c.id]);
    await runCampaign(config, join(dir, 'run'), 1, 0.1, guard);
    expect(posts).toBe(1);
    expect(reservations).toBe(1);
    expect(reconciles).toBeGreaterThan(0);
  } finally {
    globalThis.fetch = original;
    refs.forEach((key, i) => {
      if (old[i] === undefined) delete process.env[key];
      else process.env[key] = old[i];
    });
    await rm(dir, { recursive: true, force: true });
  }
});
