/**
 * What the service needs to serve a company map, built from what it already
 * has: the database it runs on, the connector registry it built at start-up,
 * and the environment that decides whether a real model is available.
 *
 * The extractor is chosen here and nowhere else. A production installation,
 * whose provider is real and has its key, extracts with the model it serves;
 * the demonstration and an installation without a key use the scripted
 * extractor, which needs no network and returns the same map twice. Both answer
 * the same interface, so nothing downstream knows which ran.
 */

import { isTerminal, jobState, type LedgerItem } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import type { BrokerService } from '../broker/service.ts';
import type { ConnectorRegistry } from '../connectors/registry.ts';
import type { Database } from '../db/client.ts';
import { job } from '../db/schema.ts';
import type { Env } from '../env.ts';
import { ExperienceEffects } from '../experience/effects.ts';
import { configuredProviders, providerSignIn } from '../gateway/configured.ts';
import type { GatewayOptions } from '../gateway/index.ts';
import {
  type ModelSettingsService,
  type ServiceModel,
  serviceModelSource,
} from '../gateway/model-settings.ts';
import { providerKeyVariables } from '../gateway/providers.ts';
import type { GatewayProvider } from '../gateway/types.ts';
import type { JobService } from '../jobs/service.ts';
import type { TriggerService } from '../jobs/triggers.ts';
import type { CompanyExtractor, ScanExtractor } from './extract.ts';
import { type FeedLimits, MANUAL_SYNC_MS, publishedAction, syncLedgerFeed } from './feeds.ts';
import { DEFAULT_EXTRACTION_MODEL, openExtractionGateway } from './gateway.ts';
import { playbookHandler } from './handler.ts';
import { connectorMailbox, MAILBOX_READ_LIMIT, type ScanMailbox } from './mailbox.ts';
import { publishedStepObjective } from './published.ts';
import { type Owner, PostgresCompanyStore } from './repository.ts';
import type { CompaniesDeps } from './routes.ts';
import { scriptedExtractor } from './scripted.ts';

/** Calls one scan's gateway admits: one per message, and a scan reads at most this many. */
export const SCAN_CALL_CEILING = MAILBOX_READ_LIMIT;

/**
 * The live extractor. Each scan opens a gateway of its own with its own call
 * budget and closes it when the scan ends, as `openExtractionGateway` is built
 * to be used, so one person's scans can never spend another's. A call made
 * outside a scan gets a gateway for that call alone.
 */
export function gatewayExtractor(options: {
  provider: string;
  model: string;
  providers: GatewayProvider[];
  currentProviders?: GatewayOptions['currentProviders'];
  fetch?: GatewayOptions['fetch'];
  privacy: GatewayOptions['privacy'];
}): CompanyExtractor {
  const open = async (): Promise<ScanExtractor> => {
    const gateway = await openExtractionGateway({
      provider: options.provider,
      model: options.model,
      providers: options.providers,
      ...(options.currentProviders ? { currentProviders: options.currentProviders } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      privacy: options.privacy,
      maxCalls: SCAN_CALL_CEILING,
    });
    return {
      extract: (request) => gateway.extractor.extract(request),
      close: gateway.close,
      unanswered: gateway.unanswered,
    };
  };
  return {
    async extract(request) {
      const once = await open();
      try {
        return await once.extract(request);
      } finally {
        await once.close();
      }
    },
    forScan: open,
  };
}

/** Model calls one person's scans may make in a day when the operator sets none. */
export const DEFAULT_DAILY_SCAN_CALLS = 500;

/**
 * The model a scan extracts with, or null for the scripted extractor.
 *
 * `MELETE_COMPANIES_MODEL` names one outright (`default` is the extraction
 * model this release was measured with). Left unset, a real provider with its
 * key extracts with the model the installation serves, so a production map is
 * read by a model without a setting nobody knew to make. The demonstration,
 * and a provider still without a key, stay scripted. The daily allowance below
 * bounds what either model path spends.
 */
export function companiesExtraction(
  env: Env,
  environment: Record<string, string | undefined> = process.env,
): { provider: string; model: string } | null {
  const named = environment.MELETE_COMPANIES_MODEL?.trim();
  if (named)
    return {
      provider: environment.MELETE_COMPANIES_PROVIDER?.trim() || env.MELETE_DEFAULT_PROVIDER,
      model: named === 'default' ? DEFAULT_EXTRACTION_MODEL : named,
    };
  if (env.MELETE_DEFAULT_PROVIDER === 'fake') return null;
  const settings = env as unknown as Record<string, string | undefined>;
  const keyed = providerKeyVariables(env.MELETE_DEFAULT_PROVIDER, env.OPENAI_COMPAT_BASE_URL).some(
    (name) => Boolean(settings[name]?.trim()),
  );
  return keyed ? { provider: env.MELETE_DEFAULT_PROVIDER, model: env.MELETE_DEFAULT_MODEL } : null;
}

/**
 * The daily allowance of model calls per person, when a live model runs.
 * `MELETE_COMPANIES_DAILY_CALLS` sets it; a scripted scan spends nothing and has none.
 */
export function configuredDailyCalls(env: Env): number | undefined {
  if (!companiesExtraction(env)) return undefined;
  return dailyCallsSetting();
}

/** The allowance `MELETE_COMPANIES_DAILY_CALLS` sets, for a model that reads scans. */
function dailyCallsSetting(): number {
  // An empty value is an unset one: `Number('')` is 0, which would stop every scan.
  const written = process.env.MELETE_COMPANIES_DAILY_CALLS?.trim();
  if (!written) return DEFAULT_DAILY_SCAN_CALLS;
  const raw = Number(written);
  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_DAILY_SCAN_CALLS;
}

/**
 * Which extractor this deployment runs, as `companiesExtraction` decides.
 *
 * With the model settings, a scan that no MELETE_COMPANIES_MODEL names reads
 * with the model new chats use, chosen in the app or not, as soon as it has a
 * key: each scan looks again when it starts, so a key connected in the app
 * applies to the next scan without a restart.
 */
export function configuredExtractor(
  env: Env,
  privacy: GatewayOptions['privacy'],
  sql?: Sql,
  settings?: ModelSettingsService,
  fetch?: GatewayOptions['fetch'],
): CompanyExtractor {
  const providers = () =>
    configuredProviders(env, () => {}, sql ? providerSignIn(sql, env) : undefined);
  const named = process.env.MELETE_COMPANIES_MODEL?.trim();
  if (!settings || named) {
    const extraction = companiesExtraction(env);
    if (!extraction) return scriptedExtractor();
    return gatewayExtractor({
      ...extraction,
      privacy,
      providers: providers(),
      ...(settings ? { currentProviders: (configured) => settings.providers(configured) } : {}),
      ...(fetch ? { fetch } : {}),
    });
  }
  const source = serviceModelSource({ env, settings });
  const scripted = scriptedExtractor();
  const configured = providers();
  const live = async (): Promise<ServiceModel | null> => {
    const choice = await source.current();
    if (choice.provider === 'fake' || !(await source.connected(choice.provider))) return null;
    return choice;
  };
  const extractorFor = (choice: ServiceModel) =>
    gatewayExtractor({
      ...choice,
      privacy,
      providers: configured,
      currentProviders: source.providers,
      ...(fetch ? { fetch } : {}),
    });
  return {
    async extract(request) {
      const choice = await live();
      return choice ? extractorFor(choice).extract(request) : scripted.extract(request);
    },
    async forScan() {
      const choice = await live();
      if (choice) {
        const scan = extractorFor(choice).forScan;
        if (scan) return scan();
      }
      return { extract: (request) => scripted.extract(request), close: async () => {} };
    },
  };
}

/**
 * The mailbox a space has, if it has one: its own active IMAP connection, read
 * through the connector the owner installed. A space with no mail connected has
 * no mailbox, and the scan route says so rather than scanning nothing.
 */
export function spaceMailbox(options: { sql: Sql; registry: ConnectorRegistry }) {
  return async (owner: Owner): Promise<ScanMailbox | null> => {
    const rows = await options.sql`select id from connection
      where space_id = ${owner.spaceId} and provider = 'imap' and status = 'active'
      order by id limit 1`;
    const id = rows[0]?.id;
    if (!id) return null;
    return connectorMailbox({
      registry: options.registry,
      connectionId: String(id),
      spaceId: owner.spaceId,
      undatedAt: new Date().toISOString(),
    });
  };
}

/**
 * The mail connection a space sends from, if it has one: its own active
 * connection holding the `email.send` scope, chosen the way sign-in already
 * chooses one. A space with nothing to send from still gets a job and a draft;
 * the job simply has no deliverable, and the person is not told otherwise.
 */
export function spaceSendConnection(options: { sql: Sql }) {
  return async (owner: Owner): Promise<string | null> => {
    const rows = await options.sql`select id from connection
      where space_id = ${owner.spaceId} and status = 'active' and scopes ? 'email.send'
      order by id limit 1`;
    const id = rows[0]?.id;
    return id ? String(id) : null;
  };
}

/**
 * Reading connections' ledger feeds and taking the steps their items offer.
 *
 * A person may ask for a read of one connection at most once a minute, by
 * default; the scheduled reads are the poller's. A step runs as an owner
 * command through the broker, so it needs the broker and its database; without
 * them, steps are not connected and the route says so.
 */
export function ledgerFeeds(options: {
  db: Database;
  registry: ConnectorRegistry;
  sql?: Sql;
  broker?: BrokerService;
  /** The shortest gap between two reads a person asks for on one connection. */
  manualGapMs?: number;
  limits?: FeedLimits;
  now?: () => Date;
}): NonNullable<CompaniesDeps['feeds']> {
  const gap = options.manualGapMs ?? MANUAL_SYNC_MS;
  const asked = new Map<string, number>();
  const effects =
    options.sql && options.broker
      ? new ExperienceEffects(options.sql, options.broker, options.registry)
      : null;
  const deps = {
    db: options.db,
    registry: options.registry,
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
  return {
    sync: (connectionId, actor) =>
      syncLedgerFeed(deps, connectionId, actor, {
        beforeRead: (id) => {
          const at = Date.now();
          const last = asked.get(id);
          if (last !== undefined && at - last < gap)
            throw new ServiceError(
              'too_soon',
              'This connection was read moments ago. Try again in a minute.',
              429,
            );
          asked.set(id, at);
        },
      }),
    action: (item: LedgerItem, actionId: string) => publishedAction(options.db, item, actionId),
    ...(effects
      ? {
          step: {
            async start(input) {
              const started = await effects.startLedgerStep({
                spaceId: input.spaceId,
                principalId: input.principalId,
                connectionId: input.connectionId,
                kind: input.toolName,
                itemId: input.itemId,
                title: `${input.label}: ${input.action.tool}`,
                objective: publishedStepObjective(input.label, input.action.tool),
              });
              if (typeof started !== 'string')
                throw new ServiceError('action_unavailable', started.reason, 409);
              return started;
            },
            async run(jobId, input) {
              const effect = await effects.runLedgerStep(jobId, {
                connectionId: input.connectionId,
                kind: input.toolName,
                payload: input.action.input,
              });
              if ('reason' in effect) throw new ServiceError('action_refused', effect.reason, 409);
              return effect.status;
            },
            abandon: (jobId, reason) => effects.abandonLedgerStep(jobId, reason),
          },
        }
      : {}),
  };
}

/** Everything the routes need, from what the service already built. */
export function companiesDeps(options: {
  db: Database;
  sql?: Sql;
  registry?: ConnectorRegistry;
  env: Env;
  /** The service's privacy router, for the scan's model calls. */
  privacy: GatewayOptions['privacy'];
  jobs?: JobService;
  triggers?: TriggerService;
  /** The model and keys connected in the app. */
  modelSettings?: ModelSettingsService;
  /** The effect boundary a published item's step is proposed to. */
  broker?: BrokerService;
}): CompaniesDeps {
  const { jobs, triggers } = options;
  // A model connected in the app may read any scan, so its allowance applies
  // unless the installation only ever runs the demonstration.
  const dailyCalls =
    configuredDailyCalls(options.env) ??
    (options.modelSettings && options.env.MELETE_DEFAULT_PROVIDER !== 'fake'
      ? dailyCallsSetting()
      : undefined);
  return {
    db: options.db,
    store: new PostgresCompanyStore(options.db),
    mailbox:
      options.sql && options.registry
        ? spaceMailbox({ sql: options.sql, registry: options.registry })
        : () => null,
    extractor: configuredExtractor(
      options.env,
      options.privacy,
      options.sql,
      options.modelSettings,
    ),
    ...(dailyCalls === undefined ? {} : { dailyCalls }),
    // Without a job service there is nothing to create a job on, and the route's
    // stub refuses. The route records `job_id` and `handling` itself once this
    // returns an id, so the handler is given no `onStatusChange` of its own.
    ...(jobs
      ? {
          cancelJob: async (id: string, reason: string) => {
            const [row] = await options.db
              .select({ state: job.state })
              .from(job)
              .where(eq(job.id, id));
            if (!row || isTerminal(jobState.parse(row.state))) return;
            await jobs.cancel(id, reason);
          },
          handler: playbookHandler({
            createJob: (input) => jobs.create(input),
            ...(triggers ? { createTrigger: (id, spec) => triggers.create(id, spec) } : {}),
          }),
        }
      : {}),
    ...(options.sql ? { sendConnection: spaceSendConnection({ sql: options.sql }) } : {}),
    ...(options.registry
      ? {
          feeds: ledgerFeeds({
            db: options.db,
            registry: options.registry,
            ...(options.sql ? { sql: options.sql } : {}),
            ...(options.broker ? { broker: options.broker } : {}),
          }),
        }
      : {}),
  };
}
