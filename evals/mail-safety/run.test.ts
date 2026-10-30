import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import corpus from './corpus.json' with { type: 'json' };
import { type Ledger, validateLedger } from './evidence.ts';
import { corpusHash, type Manifest, sha256 } from './generate.ts';
import {
  type Config,
  campaignSpend,
  checkGuardFile,
  type HardGuard,
  main,
  nextAttempt,
  requireSettlement,
  runCampaign,
} from './run.ts';

test('lead limits are explicit; smoke still refuses a third attempt', () => {
  const attempts = Array.from({ length: 2 }, (_, i) => ({ id: String(i), phase: 'settled' }));
  expect(() => nextAttempt({ attempts }, 'third', 60)).toThrow();
  expect(nextAttempt({ attempts }, 'third', 60, 60).resume).toBe(false);
  expect(() =>
    nextAttempt(
      { attempts: Array.from({ length: 60 }, (_, i) => ({ id: String(i), phase: 'settled' })) },
      'more',
      60,
      60,
    ),
  ).toThrow();
});

test('read-only guard state stops at the threshold and fails closed on missing or malformed data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mail-stop-'));
  const guardFile = join(dir, 'guard.state');
  try {
    for (const state of [
      '2026-10-30T00:24:02Z 3.00',
      '2026-10-30T00:24:02Z 3.01',
      'invalid',
      '2026-10-30T00:24:02Z NaN',
      '2026-10-30T00:24:02Z -1',
    ]) {
      await Bun.write(guardFile, state);
      await expect(checkGuardFile({ guardFile, guardStop: 3 })).rejects.toThrow();
    }
    await Bun.write(guardFile, '2026-10-30T00:24:02Z 2.9999');
    await checkGuardFile({ guardFile, guardStop: 3 });
    await expect(checkGuardFile({ guardFile })).rejects.toThrow();
    await expect(
      checkGuardFile({ guardFile: join(dir, 'missing'), guardStop: 3 }),
    ).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('campaign usage is fresh, globally scoped and deduplicated across output directories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mail-spend-'));
  const config = {
    targetId: 'target',
    campaignId: 'campaign',
    campaignLedgerFile: join(dir, 'usage.json'),
  } as Config;
  const ledger = {
    version: 1,
    targetId: 'target',
    campaignId: 'campaign',
    updatedAt: new Date().toISOString(),
    pending: 0,
    settled: true,
    submissionIds: ['mail-one'],
    usage: [{ id: 'u1', costUsd: 0.2 }],
  };
  try {
    await Bun.write(
      config.campaignLedgerFile,
      JSON.stringify({ ...ledger, usage: [...ledger.usage, ...ledger.usage] }),
    );
    expect(await campaignSpend(config, 1)).toBe(0.2);
    for (const patch of [
      { campaignId: 'other' },
      { pending: 1 },
      { settled: false },
      { updatedAt: '2020-01-01T00:00:00Z' },
      { submissionIds: [] },
      { usage: [] },
      { usage: [{ id: 'u1', costUsd: null }] },
    ]) {
      await Bun.write(config.campaignLedgerFile, JSON.stringify({ ...ledger, ...patch }));
      await expect(campaignSpend(config, 1)).rejects.toThrow();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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

test('web search rows settle without a model identity and still count toward spend', async () => {
  const model = {
    id: 'u1',
    jobId: 'job-1',
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
  const search = {
    ...model,
    id: 'u2',
    provider: 'tavily',
    requestedModel: 'search',
    actualModel: null,
    usageEstimated: false,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0.008,
    purpose: 'web_search',
  };
  const raw: Ledger = {
    version: 1,
    targetId: 'target',
    roomId: 'room',
    submissionId: 'mail-1',
    jobIds: ['job-1'],
    pending: 0,
    settled: true,
    usage: [model, search, { ...model, id: 'u3', costUsd: 0.02 }],
  };
  const ledger = validateLedger(raw, {
    targetId: 'target',
    roomId: 'room',
    submissionId: 'mail-1',
    jobId: 'job-1',
  });
  expect(() => requireSettlement({ settled: true, usage: ledger.usage }, true)).not.toThrow();
  expect(ledger.usage.reduce((sum, u) => sum + u.costUsd!, 0)).toBeCloseTo(0.038, 10);
  const dir = await mkdtemp(join(tmpdir(), 'mail-search-'));
  const config = {
    targetId: 'target',
    campaignId: 'campaign',
    campaignLedgerFile: join(dir, 'usage.json'),
  } as Config;
  try {
    await Bun.write(
      config.campaignLedgerFile,
      JSON.stringify({
        version: 1,
        targetId: 'target',
        campaignId: 'campaign',
        updatedAt: new Date().toISOString(),
        pending: 0,
        settled: true,
        submissionIds: ['mail-1'],
        usage: ledger.usage,
      }),
    );
    expect(await campaignSpend(config, 1)).toBeCloseTo(0.038, 10);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const extract = { ...search, id: 'u4', requestedModel: 'extract' };
  expect(() => requireSettlement({ settled: true, usage: [model, extract] }, true)).not.toThrow();
  for (const usage of [
    // A model provider row without an identity is still refused.
    [model, { ...model, id: 'u5', actualModel: null }],
    [model, { ...search, provider: 'nebius' }],
    // A search row that reports tokens or a model is a model call.
    [model, { ...search, outputTokens: 5 }],
    [model, { ...search, actualModel: 'some-model' }],
    [model, { ...search, requestedModel: 'nvidia/Nemotron-3.5-Super-VL' }],
    // Searching alone is not a settled model answer, and its cost must be known.
    [search],
    [model, { ...search, costUsd: null }],
  ])
    expect(() => requireSettlement({ settled: true, usage }, true)).toThrow();
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

test('full campaign requires every case and honors the external stop file before any submission', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mail-full-'));
  const original = globalThis.fetch;
  const refs = ['MAIL_FULL_OWNER', 'MAIL_FULL_HELPER', 'MAIL_FULL_OUTSIDER'];
  const old = refs.map((key) => process.env[key]);
  refs.forEach((key) => {
    process.env[key] = 'fixture';
  });
  let calls = 0;
  let reserves = 0;
  globalThis.fetch = (() => {
    calls++;
    throw new Error('No network');
  }) as unknown as typeof fetch;
  const config: Config = {
    version: 1,
    disposable: true,
    targetId: 'target',
    campaignId: 'campaign',
    baseUrl: 'https://app.example.test',
    corpusHash: corpusHash(),
    corpusDir: dir,
    requireNemotron: false,
    campaignLedgerFile: join(dir, 'usage.json'),
    accounts: {
      owner: { id: 'owner', sessionRef: refs[0]! },
      helper: { id: 'helper', sessionRef: refs[1]! },
      outsider: { id: 'outsider', sessionRef: refs[2]! },
    },
    cases: Object.fromEntries(
      corpus.cases.map((c) => [c.id, { roomId: c.id, helperLabel: 'Helper', helperConsent: true }]),
    ),
  };
  const guard: HardGuard = {
    verify: async (scope) => {
      expect(scope.maxItems).toBe(60);
      expect(scope.budgetUsd).toBe(3);
      return {
        proofId: 'proof',
        ...scope,
        capUsd: 3,
        covers: ['foreground', 'background', 'retry', 'secondary'],
        pending: 0,
        attempted: 0,
        maxItemUsd: 0.1,
      };
    },
    reserve: async () => {
      reserves++;
      throw new Error('Not admitted');
    },
    reconcile: async () => {
      throw new Error('Not admitted');
    },
  };
  try {
    await manifestAt(dir);
    const guardFile = join(dir, 'guard.state');
    await Bun.write(guardFile, '2026-10-30T00:24:02Z 5.1047');
    await expect(
      runCampaign(config, join(dir, 'run'), 60, 3, guard, { lead: true, guardFile, guardStop: 5 }),
    ).rejects.toThrow('Guard stop');
    const result = await Bun.file(join(dir, 'run', 'report.json')).json();
    expect(result.overall.attempted).toBe(0);
    const fewer = {
      ...config,
      cases: Object.fromEntries(Object.entries(config.cases).slice(0, 59)),
    };
    await expect(
      runCampaign(fewer, join(dir, 'fewer'), 60, 3, guard, { lead: true }),
    ).rejects.toThrow('namespaces');
    await expect(runCampaign(config, join(dir, 'worker'), 60, 3, guard)).rejects.toThrow(
      'item limit',
    );
    expect(calls).toBe(0);
    expect(reserves).toBe(0);
  } finally {
    globalThis.fetch = original;
    refs.forEach((key, i) => {
      if (old[i] === undefined) delete process.env[key];
      else process.env[key] = old[i];
    });
    await rm(dir, { recursive: true, force: true });
  }
});

test.each([
  [0, 0, true, false],
  [0.09, 0, false, false],
  [0, 0.09, false, false],
  [0.2, 0.2, false, true],
] as const)(
  'submission and cost reconciliation: guard=%s ledger=%s lost reply=%s cap=%s',
  async (guardCost, ledgerCost, lostReply, capNext) => {
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
    const budget = capNext ? 0.25 : 0.1;
    const limit = capNext ? 2 : 1;
    const config: Config = {
      version: 1,
      disposable: true,
      targetId: 'fixture-target',
      campaignId: 'fixture-campaign',
      baseUrl: 'https://app.example.test',
      corpusHash: corpusHash(),
      corpusDir: dir,
      campaignLedgerFile: join(dir, 'campaign-ledger.json'),
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
    if (capNext) {
      const other = corpus.cases.find((item) => item.format === 'image' && item.id !== c.id)!;
      config.cases[other.id] = { ...config.cases[c.id]!, roomId: 'room-2' };
    }
    const guard: HardGuard = {
      verify: async () => ({
        proofId: 'scripted-proof',
        targetId: config.targetId,
        campaignId: config.campaignId,
        capUsd: budget,
        maxItems: 2,
        covers: ['foreground', 'background', 'retry', 'secondary'],
        pending,
        attempted: reservations,
        maxItemUsd: capNext ? 0.2 : 0.1,
      }),
      reserve: async () => {
        reservations++;
        pending = 1;
        return { receiptId: 'hold-1' };
      },
      reconcile: async () => {
        reconciles++;
        pending = 0;
        if (capNext)
          await Bun.write(
            config.campaignLedgerFile,
            JSON.stringify({
              version: 1,
              targetId: config.targetId,
              campaignId: config.campaignId,
              updatedAt: new Date().toISOString(),
              settled: true,
              pending: 0,
              submissionIds: [`mail-${c.id}`],
              usage: [{ id: 'usage-1', costUsd: ledgerCost }],
            }),
          );
        return {
          receiptId: 'hold-1',
          settled: true,
          costUsd: guardCost,
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
      if (path.endsWith('/attachments')) {
        expect(who).toBe('fixture-0');
        return Response.json({ attachment: { id: 'file-1' } });
      }
      if (path.endsWith('/threads') && req.method === 'POST') {
        posts++;
        expect(who).toBe('fixture-0');
        if (lostReply) throw new Error('lost acknowledgement');
        return Response.json({ thread: { id: 'thread-1' }, request_job_id: 'job-1' });
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
        config.campaignLedgerFile,
        JSON.stringify({
          version: 1,
          targetId: config.targetId,
          campaignId: config.campaignId,
          updatedAt: new Date().toISOString(),
          settled: true,
          pending: 0,
          submissionIds: [],
          usage: [],
        }),
      );
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
              costUsd: ledgerCost,
              usageClass: 'interactive',
            },
          ],
        }),
      );
      await expect(runCampaign(config, join(dir, 'run'), limit, budget, guard)).rejects.toThrow(
        lostReply ? 'lost acknowledgement' : capNext ? 'Next item could exceed' : 'costs disagree',
      );
      const partial = (await Bun.file(join(dir, 'run', 'run.json')).json()) as {
        observations: unknown[];
        pending: string[];
      };
      expect(partial.observations).toHaveLength(1);
      expect(partial.pending).toEqual(capNext ? [] : [c.id]);
      if (lostReply) await runCampaign(config, join(dir, 'run'), limit, budget, guard);
      else {
        const result = await Bun.file(join(dir, 'run', 'report.json')).json();
        expect(result.overall.attempted).toBe(1);
        if (capNext) expect(result.costs.totalUsd).toBe(0.2);
        else expect(result.costs.totalUsd).toBeNull();
        expect(result.costs.guardTotalUsd).toBe(guardCost);
        if (capNext) {
          await expect(
            runCampaign(config, join(dir, 'other-run'), limit, budget, guard),
          ).rejects.toThrow('Next item could exceed');
          const other = await Bun.file(join(dir, 'other-run', 'report.json')).json();
          expect(other.overall.attempted).toBe(0);
        }
      }
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
  },
);
