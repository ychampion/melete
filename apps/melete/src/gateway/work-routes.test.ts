import { describe, expect, test } from 'bun:test';
import type { Database } from '../db/client.ts';
import {
  modelDefault,
  modelProviderKey,
  modelSecondary,
  modelVision,
  owner,
  space,
} from '../db/schema.ts';
import { loadEnv } from '../env.ts';
import { ModelSettingsService } from './model-settings.ts';
import { parseWorkRoutes, routingFromEnv, routingWarnings } from './routing.ts';
import {
  WORK_KEYWORDS,
  WORK_KINDS,
  type WorkKind,
  type WorkSignals,
  workKinds,
} from './work-routes.ts';

const DEFAULT = 'accounts/fireworks/models/deepseek-v4p1-flash';

describe('MELETE_MODEL_ROUTES is read', () => {
  test('one kind per entry, `;` or new lines between, fallbacks after commas', () => {
    const { routes, dropped } = parseWorkRoutes(
      'chat=openai/gpt-a, openai/gpt-b;\nbrowser=anthropic/claude-x\n\n research = google/gemini-y ;',
    );
    expect(routes).toEqual({
      chat: [
        { provider: 'openai', model: 'gpt-a' },
        { provider: 'openai', model: 'gpt-b' },
      ],
      browser: [{ provider: 'anthropic', model: 'claude-x' }],
      research: [{ provider: 'google', model: 'gemini-y' }],
    });
    expect(dropped).toEqual([]);
  });

  test('a model may hold slashes after its provider', () => {
    expect(parseWorkRoutes(`long=fireworks/${DEFAULT}`).routes.long).toEqual([
      { provider: 'fireworks', model: DEFAULT },
    ]);
  });

  test('an unknown kind fails, naming the setting and the kinds', () => {
    expect(() => parseWorkRoutes('voice=openai/gpt-a')).toThrow(
      'MELETE_MODEL_ROUTES names the kind "voice", which is not one of: background, team, computer, browser, long, files, research, chat.',
    );
  });

  test('a malformed model fails, naming the setting and the kinds', () => {
    for (const value of ['chat=gpt-a', 'chat=', 'chat=openai/gpt-a,', 'chat=open ai/x'])
      expect(() => parseWorkRoutes(value)).toThrow(
        /MELETE_MODEL_ROUTES \(chat\) must be written provider\/model.*Kinds: background, team/,
      );
    expect(() => parseWorkRoutes('openai/gpt-a')).toThrow(
      /MELETE_MODEL_ROUTES entries are written kind=provider\/model, with kind one of: background/,
    );
  });

  test('a kind named twice fails', () => {
    expect(() => parseWorkRoutes('chat=openai/a; chat=openai/b')).toThrow('"chat" twice');
  });

  const preset = {
    chat: ['openai/gpt-a', 'openai/gpt-b'],
    browser: ['anthropic/claude-x'],
    background: ['fireworks/small'],
  };

  test('`recommended` expands to the preset, and later entries replace its kinds', () => {
    expect(parseWorkRoutes('recommended', { preset }).routes).toEqual({
      background: [{ provider: 'fireworks', model: 'small' }],
      browser: [{ provider: 'anthropic', model: 'claude-x' }],
      chat: [
        { provider: 'openai', model: 'gpt-a' },
        { provider: 'openai', model: 'gpt-b' },
      ],
    });
    const { routes } = parseWorkRoutes('Recommended; browser=openai/gpt-c; files=openai/gpt-d', {
      preset,
    });
    expect(routes.browser).toEqual([{ provider: 'openai', model: 'gpt-c' }]);
    expect(routes.files).toEqual([{ provider: 'openai', model: 'gpt-d' }]);
    expect(routes.chat?.[0]).toEqual({ provider: 'openai', model: 'gpt-a' });
  });

  test('`recommended` is only taken first', () => {
    expect(() => parseWorkRoutes('chat=openai/a; recommended', { preset })).toThrow(
      'takes "recommended" only as its first entry',
    );
  });

  test('preset models without a key are dropped, and the start-up warns of each', () => {
    const { routes, dropped } = parseWorkRoutes('recommended', {
      preset,
      keyed: (provider) => provider === 'openai',
    });
    expect(Object.keys(routes)).toEqual(['chat']);
    expect(dropped).toEqual([
      { kind: 'background', choice: { provider: 'fireworks', model: 'small' } },
      { kind: 'browser', choice: { provider: 'anthropic', model: 'claude-x' } },
    ]);
  });

  test('the shipped preset parses, and is safe on an install with one key', () => {
    const env = { MELETE_MODEL_ROUTES: 'recommended', OPENAI_API_KEY: 'sk-test' };
    const routing = routingFromEnv(env);
    for (const models of Object.values(routing.work ?? {}))
      for (const { provider } of models) expect(provider).toBe('openai');
    for (const warning of routingWarnings(env, routing))
      expect(warning).toMatch(/leaves out|no key|never taken/);
  });

  test('the shipped preset routes every kind with only Fireworks, only Anthropic, or both, on one protocol each', () => {
    const installs = [
      { FIREWORKS_API_KEY: 'fw-test' },
      { ANTHROPIC_API_KEY: 'sk-ant-test' },
      { FIREWORKS_API_KEY: 'fw-test', ANTHROPIC_API_KEY: 'sk-ant-test' },
    ];
    for (const keys of installs) {
      const env = { MELETE_MODEL_ROUTES: 'recommended', ...keys };
      const routing = routingFromEnv(env);
      expect(Object.keys(routing.work ?? {}).sort()).toEqual([...WORK_KINDS].sort());
      for (const models of Object.values(routing.work ?? {})) {
        expect(models.length).toBeGreaterThanOrEqual(2);
        const providers = new Set(models.map((model) => model.provider));
        expect(providers.size).toBe(1);
      }
      // Alternatives for other keys are not fallbacks, so nothing is reported as never taken.
      expect(routingWarnings(env, routing)).toEqual([]);
    }
    const both = routingFromEnv({
      MELETE_MODEL_ROUTES: 'recommended',
      FIREWORKS_API_KEY: 'fw-test',
      ANTHROPIC_API_KEY: 'sk-ant-test',
    }).work;
    expect(both?.chat?.[0]?.provider).toBe('fireworks');
    expect(both?.research?.[0]).toEqual({ provider: 'anthropic', model: 'claude-haiku-5-5' });
  });

  test('a preset model on another protocol than the kind’s first keyed one is left out quietly', () => {
    const mixed = { chat: ['openai/gpt-a', 'anthropic/claude-x', 'openai/gpt-b'] };
    expect(parseWorkRoutes('recommended', { preset: mixed }).routes.chat).toEqual([
      { provider: 'openai', model: 'gpt-a' },
      { provider: 'openai', model: 'gpt-b' },
    ]);
    const { routes, dropped } = parseWorkRoutes('recommended', {
      preset: mixed,
      keyed: (provider) => provider === 'anthropic',
    });
    expect(routes.chat).toEqual([{ provider: 'anthropic', model: 'claude-x' }]);
    expect(dropped).toEqual([]);
  });

  test('unset, nothing is routed', () => {
    const routing = routingFromEnv({});
    expect(routing.work).toBeUndefined();
    expect(routing.background).toBeUndefined();
    expect(routingWarnings({}, routing)).toEqual([]);
  });

  test('the background route fills the background role', () => {
    const routing = routingFromEnv({ MELETE_MODEL_ROUTES: 'background=fireworks/small' });
    expect(routing.background).toEqual({ provider: 'fireworks', model: 'small' });
  });

  test('a fallback on another protocol is named at start-up as never taken', () => {
    const env = {
      MELETE_MODEL_ROUTES: 'chat=openai/gpt-a,anthropic/claude-x',
      OPENAI_API_KEY: 'sk-test',
      ANTHROPIC_API_KEY: 'sk-ant-test',
    };
    expect(routingWarnings(env, routingFromEnv(env))).toEqual([
      'MELETE_MODEL_ROUTES (chat) falls back to anthropic/claude-x, which speaks another protocol than openai/gpt-a; it is never taken.',
    ]);
  });

  test('the environment check refuses a bad value at start-up', () => {
    expect(() => loadEnv({ NODE_ENV: 'test', MELETE_MODEL_ROUTES: 'voice=openai/a' })).toThrow(
      /MELETE_MODEL_ROUTES/,
    );
    expect(
      loadEnv({ NODE_ENV: 'test', MELETE_MODEL_ROUTES: 'recommended; chat=openai/a' })
        .MELETE_MODEL_ROUTES,
    ).toBe('recommended; chat=openai/a');
  });
});

const quiet: WorkSignals = {
  usageClass: 'interactive',
  shared: false,
  tools: [],
  attachments: [],
  summarised: false,
  contextShare: 0,
  message: '',
};

describe('the kinds of work an attempt is', () => {
  const cases: [string, Partial<WorkSignals>, WorkKind[]][] = [
    ['an empty message is chat', {}, ['chat']],
    ['a plain message is chat', { message: 'how was your day?' }, ['chat']],
    ['background work', { usageClass: 'background' }, ['background', 'chat']],
    ['a shared space', { shared: true }, ['team', 'chat']],
    ['a computer tool used', { tools: ['computer.click'] }, ['computer', 'chat']],
    ['the terminal used', { tools: ['terminal.run__0123456789ab'] }, ['computer', 'chat']],
    ['a browser tool used', { tools: ['Browser.open'] }, ['browser', 'chat']],
    ['other tools are nothing', { tools: ['memory.search', 'mail.send'] }, ['chat']],
    ['a web search used', { tools: ['web.search'] }, ['research', 'chat']],
    ['the weather is not research', { tools: ['web.weather'] }, ['chat']],
    ['an everyday "open" is chat', { message: 'is the pharmacy open on Sunday?' }, ['chat']],
    ['a run is chat', { message: 'I went for a run this morning' }, ['chat']],
    [
      'run something in the terminal',
      { message: 'run this in the terminal for me' },
      ['computer', 'chat'],
    ],
    ['open a page', { message: 'open the page and tell me' }, ['browser', 'chat']],
    ['summarised history', { summarised: true }, ['long', 'chat']],
    ['half the window full', { contextShare: 0.5 }, ['long', 'chat']],
    ['under half the window', { contextShare: 0.49 }, ['chat']],
    ['a PDF sent', { attachments: ['pdf'] }, ['files', 'chat']],
    ['only a picture sent', { attachments: ['image'] }, ['chat']],
    ['a research ask', { message: 'Can you look into flights to Lisbon?' }, ['research', 'chat']],
    ['sources asked for', { message: 'with sources please' }, ['research', 'chat']],
    ['a browser ask', { message: 'Go to the council website' }, ['browser', 'chat']],
    ['an address', { message: 'see https://example.com/a' }, ['browser', 'chat']],
    ['a computer ask', { message: 'make a chart from this CSV' }, ['computer', 'chat']],
    [
      'everything at once, in precedence order',
      {
        usageClass: 'background',
        shared: true,
        tools: ['computer.open', 'browser.observe'],
        summarised: true,
        attachments: ['xlsx'],
        message: 'compare sources',
      },
      ['background', 'team', 'computer', 'browser', 'long', 'files', 'research', 'chat'],
    ],
  ];
  for (const [name, signals, kinds] of cases)
    test(name, () => {
      expect(workKinds({ ...quiet, ...signals })).toEqual(kinds);
    });

  test('the precedence is the documented one', () => {
    expect(WORK_KINDS).toEqual([
      'background',
      'team',
      'computer',
      'browser',
      'long',
      'files',
      'research',
      'chat',
    ]);
  });

  test('each keyword rule matches whole words only', () => {
    const rule = (kind: string) => WORK_KEYWORDS.find((entry) => entry.kind === kind)?.words;
    expect(rule('research')?.test('researching it')).toBe(true);
    expect(rule('computer')?.test('running late')).toBe(false);
    expect(rule('computer')?.test('barcode')).toBe(false);
    expect(rule('browser')?.test('reopen')).toBe(false);
    expect(rule('browser')?.test('show it in your browser')).toBe(true);
  });
});

/** The rows each table answers with; every query on a table gets them all. */
function tables(rows: Map<unknown, unknown[]>): Database {
  return {
    select: () => ({
      from: (table: unknown) => {
        const found = rows.get(table) ?? [];
        return Object.assign(Promise.resolve(found), {
          where: async () => found,
          limit: async () => found,
        });
      },
    }),
  } as unknown as Database;
}

const OWNER = 'prn_owner';

function settings(
  options: {
    chosen?: { provider: string; model: string };
    secondary?: { provider: string; model: string };
    env?: Record<string, string>;
  } = {},
) {
  const env = loadEnv({
    NODE_ENV: 'test',
    MELETE_DEFAULT_PROVIDER: 'fireworks',
    MELETE_DEFAULT_MODEL: DEFAULT,
    FIREWORKS_API_KEY: 'fw-test',
    OPENAI_API_KEY: 'sk-test',
    ...options.env,
  });
  const rows = new Map<unknown, unknown[]>([
    [modelDefault, options.chosen ? [{ id: 'installation', ...options.chosen }] : []],
    [modelProviderKey, []],
    [modelVision, []],
    [owner, [{ id: OWNER }]],
    [space, [{ owner: OWNER }]],
    [
      modelSecondary,
      options.secondary
        ? [
            {
              principalId: OWNER,
              ...options.secondary,
              sideTasks: 'secondary',
              scheduled: 'secondary',
            },
          ]
        : [],
    ],
  ]);
  return { env, service: new ModelSettingsService({ db: tables(rows), env }) };
}

const ROUTES =
  'chat=openai/gpt-a,openai/gpt-b,anthropic/claude-x; browser=anthropic/claude-y; computer=openai/gpt-c; background=openai/gpt-d';

async function choose(
  service: ModelSettingsService,
  env: Record<string, unknown>,
  usageClass: 'interactive' | 'background',
  kinds: WorkKind[],
) {
  let asked = false;
  const chosen = await service.routedChoice(routingFromEnv(env), undefined, {
    spaceId: 'spc_1',
    usageClass,
    kinds: async () => {
      asked = true;
      return kinds;
    },
  });
  return { chosen: `${chosen.provider}/${chosen.model}`, route: chosen.route, asked };
}

describe('the model an attempt runs on', () => {
  test('with no routes, the server default, and nothing is read', async () => {
    const { env, service } = settings();
    expect(await choose(service, env, 'interactive', ['computer', 'chat'])).toEqual({
      chosen: `fireworks/${DEFAULT}`,
      route: undefined,
      asked: false,
    });
  });

  test('the first kind with a connected route', async () => {
    const { env, service } = settings({ env: { MELETE_MODEL_ROUTES: ROUTES } });
    expect(await choose(service, env, 'interactive', ['computer', 'chat'])).toEqual({
      chosen: 'openai/gpt-c',
      route: 'computer',
      asked: true,
    });
    expect((await choose(service, env, 'interactive', ['research', 'chat'])).chosen).toBe(
      'openai/gpt-a',
    );
  });

  test('a route whose provider has no key is passed over', async () => {
    const { env, service } = settings({ env: { MELETE_MODEL_ROUTES: ROUTES } });
    expect(await choose(service, env, 'interactive', ['browser', 'chat'])).toEqual({
      chosen: 'openai/gpt-a',
      route: 'chat',
      asked: true,
    });
    const onlyBrowser = settings({ env: { MELETE_MODEL_ROUTES: 'browser=anthropic/claude-y' } });
    expect(
      (await choose(onlyBrowser.service, onlyBrowser.env, 'interactive', ['browser', 'chat']))
        .chosen,
    ).toBe(`fireworks/${DEFAULT}`);
  });

  test('a model the owner chose in the app wins for agent turns', async () => {
    const { env, service } = settings({
      env: { MELETE_MODEL_ROUTES: ROUTES },
      chosen: { provider: 'openai', model: 'gpt-owner' },
    });
    expect(await choose(service, env, 'interactive', ['computer', 'chat'])).toEqual({
      chosen: 'openai/gpt-owner',
      route: undefined,
      asked: false,
    });
  });

  test('background work: the background route, but the owner’s secondary still wins', async () => {
    const plain = settings({ env: { MELETE_MODEL_ROUTES: ROUTES } });
    expect(await choose(plain.service, plain.env, 'background', ['background', 'chat'])).toEqual({
      chosen: 'openai/gpt-d',
      route: 'background',
      asked: false,
    });
    const chose = settings({
      env: { MELETE_MODEL_ROUTES: ROUTES },
      chosen: { provider: 'openai', model: 'gpt-owner' },
    });
    expect((await choose(chose.service, chose.env, 'background', ['background'])).chosen).toBe(
      'openai/gpt-d',
    );
    const second = settings({
      env: { MELETE_MODEL_ROUTES: ROUTES },
      secondary: { provider: 'fireworks', model: 'small' },
    });
    expect(await choose(second.service, second.env, 'background', ['background'])).toEqual({
      chosen: 'fireworks/small',
      route: undefined,
      asked: false,
    });
  });

  test('a background route without a key leaves background work where it was', async () => {
    const { env, service } = settings({
      env: { MELETE_MODEL_ROUTES: 'background=anthropic/claude-y' },
    });
    expect((await choose(service, env, 'background', ['background'])).chosen).toBe(
      `fireworks/${DEFAULT}`,
    );
  });
});

describe('the gateway routes of a routed attempt', () => {
  test('its route’s fallbacks, then MELETE_MODEL_FALLBACK, on its own protocol only', async () => {
    const { env, service } = settings({
      env: { MELETE_MODEL_ROUTES: ROUTES, MELETE_MODEL_FALLBACK: 'openai/gpt-e,fireworks/other' },
    });
    const routes = await service.attemptRoutes(routingFromEnv(env), {
      provider: 'openai',
      model: 'gpt-a',
      usageClass: 'interactive',
    });
    expect(routes?.fallback).toEqual([
      { provider: 'openai', model: 'gpt-b' },
      { provider: 'openai', model: 'gpt-e' },
    ]);
  });

  test('an attempt on the owner’s choice still takes none', async () => {
    const { env, service } = settings({
      env: { MELETE_MODEL_ROUTES: ROUTES, MELETE_MODEL_FALLBACK: 'openai/gpt-e' },
      chosen: { provider: 'openai', model: 'gpt-a' },
    });
    expect(
      await service.attemptRoutes(routingFromEnv(env), {
        provider: 'openai',
        model: 'gpt-a',
        usageClass: 'interactive',
      }),
    ).toBeUndefined();
  });

  test('a model no route names, not the owner’s default, still takes none', async () => {
    const { env, service } = settings({
      env: { MELETE_MODEL_ROUTES: ROUTES, MELETE_MODEL_FALLBACK: 'openai/gpt-e' },
    });
    expect(
      await service.attemptRoutes(routingFromEnv(env), {
        provider: 'openai',
        model: 'gpt-z',
        usageClass: 'interactive',
      }),
    ).toBeUndefined();
  });
});
