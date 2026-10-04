/**
 * The installation's model, connected from the app.
 *
 * The owner pastes a provider key, tests it, and chooses the model new attempts
 * run on. Keys are sealed with MELETE_MASTER_KEY in one box per provider, bound
 * to the provider's name, and only their last four characters are kept in the
 * clear. Nothing here returns or logs a key.
 *
 * Precedence, so the server's own configuration never changes under it:
 * - A key the environment names for a provider (FIREWORKS_API_KEY and the rest)
 *   is used for that provider, shown as set by the operator, and cannot be
 *   replaced here. The same holds for OPENAI_COMPAT_BASE_URL.
 * - MELETE_DEFAULT_PROVIDER and MELETE_DEFAULT_MODEL are the starting model. A
 *   model chosen in the app replaces them for new attempts until it is cleared,
 *   which goes back to them.
 *
 * Every read goes to the database, so the runner and the gateway see a change
 * on the next attempt and the next model call, in any process, without a restart.
 *
 * The owner may also set a secondary model, for cheaper work beside the
 * primary in the spaces they own: short side calls (memory reads and voice
 * asides), on it by default, and scheduled and repeating work, off by
 * default. Work follows the settings of its space's owner, never those of
 * whoever spoke or asked. Chats always run on the primary, and the action
 * reviewer never moves: it is a safety check. With no secondary set,
 * everything runs as it would without one. Wherever a call goes, the privacy
 * router, spending limits and the gateway's checks still apply.
 *
 * The service's own model calls (memory reads, learning proposals, the
 * companies scan) take their model and keys from `serviceModelSource`, the same
 * way.
 *
 * A key for the OpenAI-compatible endpoint is bound to the address it was saved
 * for, the operator's or the owner's, and is only ever sent there.
 *
 * Whether the active model reads images: the owner's word, else the
 * operator's, else Melete's catalog. What the provider's model list says about
 * it is kept per provider and model whenever the list is fetched, and shown
 * beside the switch in Settings; it never turns pictures on by itself. A
 * missing or old answer is fetched in the background when Settings is read.
 */
import {
  effectiveVision,
  listedVisionByModel,
  MODEL_PROVIDERS,
  type ModelConnectionTest,
  type ModelProvider,
  type ModelRole,
  type ModelSettings,
  type SecondaryModel,
  type SecondaryWork,
} from '@melete/contracts';
import { and, eq } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import { SealedSecretStore, type SecretRepository } from '../connectors/secrets.ts';
import type { Database } from '../db/client.ts';
import {
  modelDefault,
  modelProviderKey,
  modelSecondary,
  modelVision,
  modelVisionReport,
  owner,
  space,
  trigger,
} from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import type { Env } from '../env.ts';
import type { ProviderSignIn } from './credentials.ts';
import {
  CHATGPT_PROVIDER,
  compatibleBaseUrl,
  OPENAI_COMPATIBLE,
  openAiCompatibleProvider,
  providersFromEnv,
  providerUrl,
} from './providers.ts';
import { addressIsLocal, agentRoutes, type ModelRouting, sameModel } from './routing.ts';
import type { GatewayProvider, GatewayRoutes, SignedInCredential } from './types.ts';

export const MODEL_PROVIDER_LABELS: Record<ModelProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  fireworks: 'Fireworks',
  'openai-compatible': 'OpenAI-compatible endpoint',
  chatgpt: 'ChatGPT',
};

/** How long a connection test waits for the provider. */
export const MODEL_TEST_TIMEOUT_MS = 10_000;
/** A provider that lists thousands of models is cut to this many, sorted. */
const MODEL_LIST_LIMIT = 1000;
/** A provider's answer on vision older than this is fetched again, in the background. */
export const VISION_REPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** The least time between two background fetches of one provider's list, per process. */
export const VISION_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
/**
 * Providers whose model list says which models read images, and so is worth
 * fetching in the background: Fireworks (`supports_image_input`) and the
 * compatible endpoints that answer like OpenRouter. Any other list is still
 * read for an answer when the owner tests the connection.
 */
const LISTS_REPORT_VISION = new Set<string>(['fireworks', OPENAI_COMPATIBLE]);

type KeyRow = typeof modelProviderKey.$inferSelect;
type Runner = Database | Transaction;

const isModelProvider = (name: string): name is ModelProvider =>
  (MODEL_PROVIDERS as readonly string[]).includes(name);

/** The built-in providers' addresses, from the one provider table. */
const BUILT_IN = new Map(providersFromEnv({}).map((provider) => [provider.name, provider]));

/**
 * Sealing binds the provider into the box, so a ciphertext copied onto another
 * provider's row does not open.
 */
function keyBox(masterKey: () => string | undefined) {
  const binding = (provider: string) => `model-key:${provider}`;
  return {
    async seal(provider: string, key: string) {
      let written: { id: string; ciphertext: string } | undefined;
      const one: SecretRepository = {
        put: async (id, _space, ciphertext) => {
          written = { id, ciphertext };
        },
        get: async () => null,
      };
      await new SealedSecretStore(one, masterKey).put(binding(provider), key);
      if (!written) throw new Error('Secret unavailable');
      return written;
    },
    async open(row: Pick<KeyRow, 'provider' | 'secretId' | 'ciphertext'>): Promise<string> {
      const one: SecretRepository = {
        put: async () => {},
        get: async (id) => (id === row.secretId ? row.ciphertext : null),
      };
      return new SealedSecretStore(one, masterKey).withSecret(
        row.secretId,
        binding(row.provider),
        async (value) => value,
      );
    },
  };
}

export interface ModelSettingsOptions {
  db: Database;
  env: Env;
  signIn?: ProviderSignIn;
  masterKey?: () => string | undefined;
  /** The transport a connection test uses; tests pass a mock. */
  fetch?: (request: Request) => Promise<Response>;
  timeoutMs?: number;
}

export class ModelSettingsService {
  private readonly box: ReturnType<typeof keyBox>;
  private readonly masterKey: () => string | undefined;
  /** When each provider's list was last fetched in the background, by this process. */
  private readonly refreshedAt = new Map<string, number>();
  /** The background fetch in flight, if any, per provider. */
  private readonly refreshing = new Map<string, Promise<void>>();

  constructor(private readonly options: ModelSettingsOptions) {
    this.masterKey = options.masterKey ?? (() => options.env.MELETE_MASTER_KEY);
    this.box = keyBox(this.masterKey);
  }

  private get env() {
    return this.options.env;
  }

  /** The environment's key for a provider, which always wins over one entered in the app. */
  operatorKey(provider: string): string | undefined {
    const env = this.env;
    switch (provider) {
      case 'fireworks':
        return env.FIREWORKS_API_KEY || undefined;
      case 'openai':
        return env.OPENAI_API_KEY || undefined;
      case 'anthropic':
        return env.ANTHROPIC_API_KEY || undefined;
      case 'google':
        return env.GOOGLE_API_KEY || undefined;
      case OPENAI_COMPATIBLE: {
        const base = this.operatorBaseUrl();
        if (!base) return undefined;
        return (
          env.OPENAI_COMPAT_API_KEY ||
          (base.startsWith('https:') ? env.OPENAI_API_KEY : undefined) ||
          undefined
        );
      }
      default:
        return undefined;
    }
  }

  private operatorBaseUrl(): string | undefined {
    const address = this.env.OPENAI_COMPAT_BASE_URL;
    return address ? compatibleBaseUrl(address) : undefined;
  }

  /** The operator configured sign-in, not a key, for this provider. */
  private operatorSignIn(provider: string): boolean {
    return provider !== CHATGPT_PROVIDER && Boolean(this.options.signIn?.handles(provider));
  }

  private async keyRows(db: Runner = this.options.db): Promise<Map<string, KeyRow>> {
    const rows = await db.select().from(modelProviderKey);
    return new Map(rows.map((row) => [row.provider, row]));
  }

  private async chosen(db: Runner = this.options.db) {
    const [row] = await db.select().from(modelDefault).where(eq(modelDefault.id, 'installation'));
    return row ?? null;
  }

  private async signedIn(provider: string): Promise<boolean> {
    const signIn = this.options.signIn;
    if (!signIn?.handles(provider)) return false;
    return (await signIn.status(provider)).state === 'signed_in';
  }

  /** Whether a model call to this provider would carry a credential. */
  private async connected(provider: string, rows: Map<string, KeyRow>): Promise<boolean> {
    if (provider === 'fake') return this.env.MELETE_ENABLE_FAKE_PROVIDER;
    if (provider === CHATGPT_PROVIDER || this.operatorSignIn(provider))
      return this.signedIn(provider);
    if (this.operatorKey(provider)) return true;
    return Boolean(this.usableRow(provider, rows));
  }

  /**
   * The stored key a call to this provider may carry. A compatible endpoint's
   * key only goes to the address it was saved for: when the operator's address
   * has changed since, it is not used.
   */
  private usableRow(provider: string, rows: Map<string, KeyRow>): KeyRow | undefined {
    const row = rows.get(provider);
    if (!row || provider !== OPENAI_COMPATIBLE) return row;
    if (!row.baseUrl) return undefined;
    const operatorBase = this.operatorBaseUrl();
    return !operatorBase || operatorBase === row.baseUrl ? row : undefined;
  }

  /**
   * Whether this provider is a model server on the owner's machine or network:
   * the OpenAI-compatible endpoint at a local address, as the operator or the
   * owner connected it.
   */
  async servesLocally(provider: string): Promise<boolean> {
    if (provider !== OPENAI_COMPATIBLE) return false;
    const base =
      this.operatorBaseUrl() ??
      this.usableRow(provider, await this.keyRows())?.baseUrl ??
      undefined;
    return addressIsLocal(base);
  }

  /** Whether a model call to this provider would carry a credential now. */
  async isConnected(provider: string): Promise<boolean> {
    return this.connected(provider, await this.keyRows());
  }

  /**
   * The model the next attempt runs on: the one chosen in the app, or the
   * server's default. Read inside the claim transaction.
   */
  async activeChoice(
    db: Runner = this.options.db,
  ): Promise<{ provider: string; model: string; vision: boolean }> {
    const { provider, model, vision } = await this.active(await this.chosen(db), db);
    return { provider, model, vision };
  }

  /**
   * The model the next attempt runs on, as `activeChoice`, told to send its
   * pictures when the operator configured a vision model that will read them
   * for it. A model the owner chose in the app is used exactly as chosen.
   */
  async routedChoice(
    routing: ModelRouting,
    db: Runner = this.options.db,
    work?: ScheduledWorkRow,
  ): Promise<{ provider: string; model: string; vision: boolean }> {
    // A person's scheduled work runs on their secondary when they said so.
    const secondary = work ? await this.scheduledSecondary(work, db) : null;
    if (secondary)
      return {
        ...secondary,
        vision: effectiveVision(
          secondary.provider,
          secondary.model,
          await this.visionSaid(secondary.provider, secondary.model, db),
        ),
      };
    const chosen = await this.chosen(db);
    const { provider, model, vision } = await this.active(chosen, db);
    const routes = agentRoutes(
      routing,
      { provider, model },
      { ownerChose: this.ownerChose({ provider, model }), primaryReadsImages: vision },
    );
    return { provider, model, vision: vision || Boolean(routes?.vision) };
  }

  /**
   * Whether this model is one the owner chose in the app rather than the
   * server's default. Agent turns on an owner's choice are never rerouted.
   */
  private ownerChose(choice: { provider: string; model: string }): boolean {
    return !sameModel(choice, {
      provider: this.env.MELETE_DEFAULT_PROVIDER,
      model: this.env.MELETE_DEFAULT_MODEL,
    });
  }

  /**
   * The operator's alternatives for an attempt on this model: a vision model
   * for its pictures when it reads none, and fallbacks. None when the owner
   * chose the model in the app.
   */
  async attemptRoutes(
    routing: ModelRouting,
    primary: { provider: string; model: string },
  ): Promise<GatewayRoutes | undefined> {
    if (this.ownerChose(primary)) return undefined;
    const owner = await this.visionSaid(primary.provider, primary.model);
    const readsImages = effectiveVision(
      primary.provider,
      primary.model,
      owner ?? this.env.MELETE_DEFAULT_MODEL_VISION ?? null,
    );
    return agentRoutes(routing, primary, { ownerChose: false, primaryReadsImages: readsImages });
  }

  /**
   * Whether this model is shown pictures, for the model a request names: what
   * the app says for the model in use, else the owner's word on this model,
   * else Melete's list.
   */
  async visionFor(provider: string, model: string): Promise<boolean> {
    const active = await this.active(await this.chosen());
    if (active.provider === provider && active.model === model) return active.vision;
    return effectiveVision(provider, model, await this.visionSaid(provider, model));
  }

  /** The owner's word on this model reading images, given apart from choosing it. */
  private async visionSaid(
    provider: string,
    model: string,
    db: Runner = this.options.db,
  ): Promise<boolean | null> {
    const [row] = await db
      .select()
      .from(modelVision)
      .where(and(eq(modelVision.provider, provider), eq(modelVision.model, model)));
    return row?.supportsVision ?? null;
  }

  /**
   * The model in use and whether it is shown pictures: the owner's word on
   * this model, given by itself or when choosing it in the app; else the
   * operator's for the server default; else the catalog's. Which of them said
   * so never changes where the model itself came from. The provider's list
   * does not decide it.
   */
  private async active(
    chosen: Awaited<ReturnType<ModelSettingsService['chosen']>>,
    db: Runner = this.options.db,
  ) {
    const provider = chosen?.provider ?? this.env.MELETE_DEFAULT_PROVIDER;
    const model = chosen?.model ?? this.env.MELETE_DEFAULT_MODEL;
    const owner = (await this.visionSaid(provider, model, db)) ?? chosen?.supportsVision ?? null;
    const stated = owner ?? (chosen ? null : this.env.MELETE_DEFAULT_MODEL_VISION);
    return {
      provider,
      model,
      vision: effectiveVision(provider, model, stated),
      vision_source:
        typeof owner === 'boolean'
          ? ('app' as const)
          : typeof stated === 'boolean'
            ? ('operator' as const)
            : ('catalog' as const),
    };
  }

  /**
   * What the provider's list last said about this model. When it has said
   * nothing yet, or said it long ago, its list is fetched again in the
   * background; the answer in hand is used meanwhile.
   */
  private async report(provider: string, model: string, db: Runner = this.options.db) {
    if (!isModelProvider(provider) || provider === CHATGPT_PROVIDER) return undefined;
    const [row] = await db
      .select({
        supportsVision: modelVisionReport.supportsVision,
        reportedAt: modelVisionReport.reportedAt,
      })
      .from(modelVisionReport)
      .where(and(eq(modelVisionReport.provider, provider), eq(modelVisionReport.model, model)));
    const stale = !row || Date.now() - row.reportedAt.getTime() > VISION_REPORT_MAX_AGE_MS;
    // Only lists known to answer are fetched unasked; a test passes its own transport.
    if (
      stale &&
      LISTS_REPORT_VISION.has(provider) &&
      (this.options.fetch || this.env.NODE_ENV !== 'test')
    )
      void this.refreshVision(provider);
    return row;
  }

  /**
   * Fetches the provider's model list in the background and keeps what it says
   * about vision. At most one fetch per provider at a time, and one an hour;
   * a provider that cannot be reached leaves the stored answers as they were.
   */
  refreshVision(provider: ModelProvider): Promise<void> {
    const inFlight = this.refreshing.get(provider);
    if (inFlight) return inFlight;
    const last = this.refreshedAt.get(provider);
    if (last !== undefined && Date.now() - last < VISION_REFRESH_INTERVAL_MS)
      return Promise.resolve();
    this.refreshedAt.set(provider, Date.now());
    const run = (async () => {
      try {
        const base = await this.configuredBase(provider);
        const key = base ? await this.currentKey(provider) : undefined;
        if (!base || !key) return;
        const listed = await this.list(provider, base, key);
        if (listed.ok) await this.remember(provider, listed.body);
      } catch (error) {
        console.warn(`Couldn’t refresh ${provider}’s model list: ${describe(error)}`);
      } finally {
        this.refreshing.delete(provider);
      }
    })();
    this.refreshing.set(provider, run);
    return run;
  }

  /**
   * Keeps what a fetched model list says about vision, replacing the
   * provider's earlier answers. A list that says nothing about vision leaves
   * them alone. Never throws: the list was fetched for something else.
   */
  private async remember(provider: string, body: unknown): Promise<void> {
    const answers = listedVisionByModel(body);
    if (!answers.size) return;
    const reportedAt = new Date();
    const rows = [...answers].map(([model, supportsVision]) => ({
      provider,
      model,
      supportsVision,
      reportedAt,
    }));
    try {
      await this.options.db.transaction(async (tx) => {
        await tx.delete(modelVisionReport).where(eq(modelVisionReport.provider, provider));
        for (let start = 0; start < rows.length; start += 500)
          await tx.insert(modelVisionReport).values(rows.slice(start, start + 500));
      });
    } catch (error) {
      console.warn(`Couldn’t keep ${provider}’s vision answers: ${describe(error)}`);
    }
  }

  /** Forgets a provider's answers, when its address or key changes. */
  private async forgetReports(provider: string): Promise<void> {
    await this.options.db.delete(modelVisionReport).where(eq(modelVisionReport.provider, provider));
    this.refreshedAt.delete(provider);
  }

  /**
   * Say whether the model in use reads images, or with null hand that back to
   * Melete's list. It changes nothing else: the model, and whether it was
   * chosen here or is the server's default, stay as they are.
   */
  async setVision(
    provider: string,
    model: string,
    ownerId: string,
    supportsVision: boolean | null,
  ): Promise<void> {
    const chosen = await this.chosen();
    const active = await this.active(chosen);
    if (active.provider !== provider || active.model !== model.trim())
      throw new ServiceError(
        'model_changed',
        'The model in use has changed since this page loaded. Reload and try again.',
        409,
      );
    await this.options.db.transaction(async (tx) => {
      if (supportsVision === null) {
        await tx
          .delete(modelVision)
          .where(and(eq(modelVision.provider, provider), eq(modelVision.model, active.model)));
        // An answer given when the model was chosen is handed back too, and
        // the choice itself is left as it was.
        if (chosen && chosen.supportsVision !== null)
          await tx
            .update(modelDefault)
            .set({ supportsVision: null })
            .where(eq(modelDefault.id, 'installation'));
        return;
      }
      const values = {
        provider,
        model: active.model,
        supportsVision,
        ownerId,
        updatedAt: new Date(),
      };
      await tx
        .insert(modelVision)
        .values(values)
        .onConflictDoUpdate({ target: [modelVision.provider, modelVision.model], set: values });
    });
  }

  async view(
    canEdit: boolean,
    person?: { id: string; guest?: boolean } | null,
  ): Promise<ModelSettings> {
    const [rows, chosen] = await Promise.all([this.keyRows(), this.chosen()]);
    const active = await this.active(chosen);
    const reported = await this.report(active.provider, active.model);
    const providers = await Promise.all(
      MODEL_PROVIDERS.map(async (provider) => {
        const row = this.usableRow(provider, rows);
        const byOperator =
          provider !== CHATGPT_PROVIDER &&
          (Boolean(this.operatorKey(provider)) || this.operatorSignIn(provider));
        const compatible = provider === OPENAI_COMPATIBLE;
        const operatorBase = compatible ? this.operatorBaseUrl() : undefined;
        return {
          provider,
          label:
            compatible && this.env.OPENAI_COMPAT_OAUTH_LABEL
              ? this.env.OPENAI_COMPAT_OAUTH_LABEL
              : MODEL_PROVIDER_LABELS[provider],
          method: provider === CHATGPT_PROVIDER ? ('sign_in' as const) : ('key' as const),
          key: byOperator
            ? { state: 'operator' as const, last_four: null, updated_at: null }
            : row
              ? {
                  state: 'set' as const,
                  last_four: row.lastFour,
                  updated_at: row.updatedAt.toISOString(),
                }
              : { state: 'unset' as const, last_four: null, updated_at: null },
          base_url: compatible ? (operatorBase ?? row?.baseUrl ?? null) : null,
          base_url_source: compatible
            ? operatorBase
              ? ('operator' as const)
              : row?.baseUrl
                ? ('app' as const)
                : null
            : null,
          connected: await this.connected(provider, rows),
          lists_models: provider !== CHATGPT_PROVIDER,
        };
      }),
    );
    return {
      active: {
        ...active,
        provider_vision: reported?.supportsVision ?? null,
        source: chosen ? 'app' : 'operator',
        connected: await this.connected(active.provider, rows),
        updated_at: chosen?.updatedAt.toISOString() ?? null,
      },
      operator_default: {
        provider: this.env.MELETE_DEFAULT_PROVIDER,
        model: this.env.MELETE_DEFAULT_MODEL,
      },
      providers,
      can_edit: canEdit,
      can_store_keys: Boolean(this.masterKey()),
      secondary: await this.secondaryView(person ?? null, rows),
    };
  }

  /** A person's secondary model as Settings shows it. */
  private async secondaryView(
    person: { id: string; guest?: boolean } | null,
    rows: Map<string, KeyRow>,
  ): Promise<SecondaryModel> {
    const row = person ? await this.secondaryRow(person.id) : null;
    return {
      model:
        row?.provider && row.model
          ? {
              provider: row.provider,
              model: row.model,
              connected: await this.connected(row.provider, rows),
            }
          : null,
      uses: {
        side_tasks: (row?.sideTasks as ModelRole | undefined) ?? 'secondary',
        scheduled: (row?.scheduled as ModelRole | undefined) ?? 'primary',
      },
      can_edit: Boolean(person && !person.guest && (await this.isInstallationOwner(person.id))),
      updated_at: row?.updatedAt.toISOString() ?? null,
    };
  }

  /**
   * Whether this principal runs the installation. Only they choose models on
   * its keys, so only their secondary is ever used, as only they set the primary.
   */
  private async isInstallationOwner(principalId: string, db: Runner = this.options.db) {
    const [row] = await db.select({ id: owner.id }).from(owner).limit(1);
    return row?.id === principalId;
  }

  private async secondaryRow(principalId: string, db: Runner = this.options.db) {
    const [row] = await db
      .select()
      .from(modelSecondary)
      .where(eq(modelSecondary.principalId, principalId));
    return row ?? null;
  }

  /**
   * Choose a person's secondary model. Like the primary, its provider must
   * already have a key or a sign-in. Which work uses it is left as it was.
   */
  async setSecondary(principalId: string, provider: string, model: string): Promise<void> {
    if (!isModelProvider(provider))
      throw new ServiceError(
        'provider_not_available',
        'That is not a provider Melete serves.',
        404,
      );
    if (!(await this.connected(provider, await this.keyRows())))
      throw new ServiceError(
        'model_not_connected',
        provider === CHATGPT_PROVIDER
          ? 'Sign in to ChatGPT before choosing one of its models.'
          : `Add a key for ${MODEL_PROVIDER_LABELS[provider]} before choosing one of its models.`,
        409,
      );
    const set = { provider, model: model.trim(), updatedAt: new Date() };
    await this.options.db
      .insert(modelSecondary)
      .values({ principalId, ...set })
      .onConflictDoUpdate({ target: modelSecondary.principalId, set });
  }

  /** Remove a person's secondary model: all their work runs on the primary again. */
  async clearSecondary(principalId: string): Promise<void> {
    await this.options.db
      .update(modelSecondary)
      .set({ provider: null, model: null, updatedAt: new Date() })
      .where(eq(modelSecondary.principalId, principalId));
  }

  /** Which of a person's work runs on their secondary. Kinds left out keep their setting. */
  async setSecondaryUses(
    principalId: string,
    uses: Partial<Record<SecondaryWork, ModelRole>>,
  ): Promise<void> {
    const set = {
      ...(uses.side_tasks ? { sideTasks: uses.side_tasks } : {}),
      ...(uses.scheduled ? { scheduled: uses.scheduled } : {}),
      updatedAt: new Date(),
    };
    await this.options.db
      .insert(modelSecondary)
      .values({ principalId, ...set })
      .onConflictDoUpdate({ target: modelSecondary.principalId, set });
  }

  /**
   * The secondary model this person's work of this kind runs on, or null for
   * the primary: none is set, the person kept this work on the primary, or
   * its provider has no credential now.
   */
  async secondaryFor(
    principalId: string | null | undefined,
    work: SecondaryWork,
    db: Runner = this.options.db,
  ): Promise<ServiceModel | null> {
    if (!principalId || !(await this.isInstallationOwner(principalId, db))) return null;
    const row = await this.secondaryRow(principalId, db);
    if (!row?.provider || !row.model) return null;
    if ((work === 'side_tasks' ? row.sideTasks : row.scheduled) !== 'secondary') return null;
    if (!(await this.connected(row.provider, await this.keyRows(db)))) return null;
    return { provider: row.provider, model: row.model };
  }

  /** The primary model and this person's secondary, as usage labels them. */
  async roles(principalId: string | undefined): Promise<{
    primary: ServiceModel;
    secondary: ServiceModel | null;
  }> {
    const { provider, model } = await this.activeChoice();
    const row = principalId ? await this.secondaryRow(principalId) : null;
    return {
      primary: { provider, model },
      secondary: row?.provider && row.model ? { provider: row.provider, model: row.model } : null,
    };
  }

  /**
   * The secondary a short side call about work in this space runs on: that of
   * the space's owner, never that of whoever is speaking or asked. Null for
   * the usual model.
   */
  async sideTaskModel(whose: SideCallOwner): Promise<ServiceModel | null> {
    return this.secondaryFor(await this.spaceOwner(whose.spaceId), 'side_tasks');
  }

  /** Whose settings work in a space follows: the space's owner. */
  private async spaceOwner(spaceId: string, db: Runner = this.options.db) {
    const [row] = await db
      .select({ owner: space.ownerPrincipalId })
      .from(space)
      .where(eq(space.id, spaceId));
    return row?.owner ?? null;
  }

  /**
   * The secondary an attempt of this job runs on, when it is scheduled or
   * repeating work (a routine, or work that wakes on a trigger) and the owner
   * of its space moved that work to their secondary. A chat is never moved.
   */
  private async scheduledSecondary(
    work: ScheduledWorkRow,
    db: Runner,
  ): Promise<ServiceModel | null> {
    if (work.kind === 'chat') return null;
    if (work.kind !== 'routine') {
      const [standing] = await db
        .select({ id: trigger.id })
        .from(trigger)
        .where(and(eq(trigger.jobId, work.id), eq(trigger.enabled, true)))
        .limit(1);
      if (!standing) return null;
    }
    return this.secondaryFor(await this.spaceOwner(work.spaceId, db), 'scheduled', db);
  }

  async saveKey(
    provider: string,
    ownerId: string,
    input: { api_key: string; base_url?: string },
  ): Promise<void> {
    if (!isModelProvider(provider) || provider === CHATGPT_PROVIDER)
      throw new ServiceError(
        'provider_not_available',
        'That provider is not connected by key.',
        404,
      );
    if (this.operatorKey(provider) || this.operatorSignIn(provider))
      throw new ServiceError(
        'set_by_operator',
        'The server configuration already sets this provider’s key, so it cannot be changed here.',
        409,
      );
    if (!this.masterKey())
      throw new ServiceError(
        'master_key_required',
        'Storing a key needs MELETE_MASTER_KEY on the server to seal it.',
        503,
      );
    const key = input.api_key.trim();
    if (key.length < 8 || /\s/.test(key))
      throw new ServiceError(
        'invalid_key',
        'That does not look like an API key. Paste the whole key, without spaces.',
        400,
      );
    // A compatible endpoint's key is bound to the address it is saved for.
    let baseUrl: string | null = null;
    if (provider === OPENAI_COMPATIBLE) baseUrl = this.operatorBaseUrl() ?? null;
    if (provider === OPENAI_COMPATIBLE && !baseUrl) {
      if (!input.base_url)
        throw new ServiceError(
          'invalid_address',
          'Give the endpoint’s address, for example https://models.example.net/v1.',
          400,
        );
      baseUrl = checkedBaseUrl(input.base_url);
    }
    const sealed = await this.box.seal(provider, key);
    const values = {
      provider,
      ownerId,
      secretId: sealed.id,
      ciphertext: sealed.ciphertext,
      lastFour: key.slice(-4),
      baseUrl,
      updatedAt: new Date(),
    };
    await this.options.db
      .insert(modelProviderKey)
      .values(values)
      .onConflictDoUpdate({ target: modelProviderKey.provider, set: values });
    // Another key can see other models, and a compatible endpoint's key may
    // come with a new address: what the old list said no longer holds.
    await this.forgetReports(provider);
  }

  async removeKey(provider: string): Promise<void> {
    await this.options.db.delete(modelProviderKey).where(eq(modelProviderKey.provider, provider));
    await this.forgetReports(provider);
  }

  async setDefault(
    provider: string,
    model: string,
    ownerId: string,
    supportsVision: boolean | null = null,
  ): Promise<void> {
    if (!isModelProvider(provider))
      throw new ServiceError(
        'provider_not_available',
        'That is not a provider Melete serves.',
        404,
      );
    if (!(await this.connected(provider, await this.keyRows())))
      throw new ServiceError(
        'model_not_connected',
        provider === CHATGPT_PROVIDER
          ? 'Sign in to ChatGPT before choosing one of its models.'
          : `Add a key for ${MODEL_PROVIDER_LABELS[provider]} before choosing one of its models.`,
        409,
      );
    const values = {
      id: 'installation',
      provider,
      model: model.trim(),
      // Belongs to this model: choosing another one starts from the catalog again.
      supportsVision,
      ownerId,
      updatedAt: new Date(),
    };
    await this.options.db
      .insert(modelDefault)
      .values(values)
      .onConflictDoUpdate({ target: modelDefault.id, set: values });
  }

  async clearDefault(): Promise<void> {
    await this.options.db.delete(modelDefault).where(eq(modelDefault.id, 'installation'));
  }

  /**
   * The gateway's providers for one request: the configured ones, with each
   * key entered in the app attached where the environment gave none, and the
   * OpenAI-compatible endpoint added when the owner connected one. A stored key
   * is opened only when a call is made with it.
   */
  async providers(configured: GatewayProvider[]): Promise<GatewayProvider[]> {
    const rows = await this.keyRows();
    if (!rows.size) return configured;
    const result = configured.map((provider) => {
      const row = rows.get(provider.name);
      // A compatible endpoint's key is attached only at the address it was saved for.
      const boundHere = provider.name !== OPENAI_COMPATIBLE || row?.baseUrl === provider.baseUrl;
      return row && boundHere && !provider.fake && !provider.apiKey && !provider.signedIn
        ? { ...provider, signedIn: this.storedCredential(row) }
        : provider;
    });
    const compatible = rows.get(OPENAI_COMPATIBLE);
    if (compatible?.baseUrl && !result.some((provider) => provider.name === OPENAI_COMPATIBLE))
      result.push({
        ...openAiCompatibleProvider(compatible.baseUrl),
        signedIn: this.storedCredential(compatible),
      });
    return result;
  }

  /** A stored key, handed to the gateway the way a signed-in token is. */
  private storedCredential(row: KeyRow): SignedInCredential {
    return {
      current: async () => ({ token: await this.box.open(row), generation: 0, headers: {} }),
      // A refused key stays as it is; the owner replaces it in Settings.
      rejected: () => {},
    };
  }

  /** The key a test uses when none is typed: the environment's, else the stored one. */
  private async currentKey(provider: string): Promise<string | undefined> {
    const operator = this.operatorKey(provider);
    if (operator) return operator;
    const row = this.usableRow(provider, await this.keyRows());
    return row ? this.box.open(row) : undefined;
  }

  /**
   * One small authenticated call: the provider's model list. It proves the key
   * and address and gives the owner something to choose from. Only what the
   * list says about which models read images is kept.
   */
  async test(input: {
    provider: string;
    api_key?: string;
    base_url?: string;
  }): Promise<ModelConnectionTest> {
    const { provider } = input;
    if (!isModelProvider(provider) || provider === CHATGPT_PROVIDER)
      throw new ServiceError(
        'provider_not_available',
        'That provider is not connected by key.',
        404,
      );
    const label = MODEL_PROVIDER_LABELS[provider];
    const failed = (
      code: Extract<ModelConnectionTest, { ok: false }>['code'],
      message: string,
      status: number | null = null,
    ): ModelConnectionTest => ({ ok: false, code, message, status });

    let base: string;
    const configuredBase = await this.configuredBase(provider);
    try {
      base =
        provider === OPENAI_COMPATIBLE && input.base_url
          ? checkedBaseUrl(input.base_url)
          : (configuredBase ?? '');
    } catch {
      return failed('invalid_address', INVALID_ADDRESS);
    }
    if (!base) return failed('invalid_address', INVALID_ADDRESS);

    const typed = input.api_key?.trim();
    // A saved key only ever goes to the address it was saved for.
    if (!typed && base !== configuredBase)
      return failed('no_key', 'Paste the key to try it with a new address.');
    let key: string | undefined;
    try {
      key = typed || (await this.currentKey(provider));
    } catch {
      return failed('no_key', 'The saved key could not be opened. Paste it again.');
    }
    if (!key) return failed('no_key', `Paste your ${label} API key first.`);

    const listed = await this.list(provider, base, key);
    if (!listed.ok) return listed;
    // What the list says about vision is kept for the address in use; a list
    // from an address not yet saved describes some other endpoint.
    if (base === configuredBase) await this.remember(provider, listed.body);
    return { ok: true, models: modelIds(listed.body), latency_ms: listed.latency_ms };
  }

  /** The address a provider's model list is fetched from: built in, or the compatible endpoint's. */
  private async configuredBase(provider: ModelProvider): Promise<string | undefined> {
    return provider === OPENAI_COMPATIBLE
      ? (this.operatorBaseUrl() ??
          this.usableRow(provider, await this.keyRows())?.baseUrl ??
          undefined)
      : BUILT_IN.get(provider)?.baseUrl;
  }

  /** Fetches the provider's model list, or says in plain words why it could not. */
  private async list(
    provider: ModelProvider,
    base: string,
    key: string,
  ): Promise<
    { ok: true; body: unknown; latency_ms: number } | Extract<ModelConnectionTest, { ok: false }>
  > {
    const label = MODEL_PROVIDER_LABELS[provider];
    const failed = (
      code: Extract<ModelConnectionTest, { ok: false }>['code'],
      message: string,
      status: number | null = null,
    ) => ({ ok: false as const, code, message, status });
    const url = new URL('models', base);
    const headers = new Headers({ accept: 'application/json' });
    if (provider === 'anthropic') {
      headers.set('x-api-key', key);
      headers.set('anthropic-version', '2023-06-01');
    } else headers.set('authorization', `Bearer ${key}`);
    const transport = this.options.fetch ?? ((request: Request) => fetch(request));
    const timeoutMs = this.options.timeoutMs ?? MODEL_TEST_TIMEOUT_MS;
    const started = performance.now();
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The timer is the service's own, so a transport that ignores the signal
    // still cannot hold the owner's request open.
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error('timed out');
        error.name = 'TimeoutError';
        abort.abort(error);
        reject(error);
      }, timeoutMs);
    });
    let response: Response;
    let body: unknown = null;
    try {
      response = await Promise.race([
        transport(
          new Request(url.href, {
            method: 'GET',
            headers,
            redirect: 'manual',
            signal: abort.signal,
          }),
        ),
        expired,
      ]);
      if (response.ok) body = await Promise.race([response.json().catch(() => null), expired]);
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError')
        return failed(
          'timeout',
          `${label} did not answer within ${Math.round(timeoutMs / 1000)} seconds. Check the address and this server’s network, then try again.`,
        );
      return failed(
        'unreachable',
        `Couldn’t reach ${url.host}. Check the address and that this server can reach it.`,
      );
    } finally {
      clearTimeout(timer);
    }
    const status = response.status;
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (status === 401 || status === 403)
        return failed(
          'key_refused',
          `${label} did not accept this key (HTTP ${status}). Check that the whole key was copied and that it is still active.`,
          status,
        );
      if (status === 404 || (status >= 300 && status < 400))
        return failed(
          'not_found',
          provider === OPENAI_COMPATIBLE
            ? `Nothing answered at ${url.href} (HTTP ${status}). Check the address; it usually ends in /v1.`
            : `${label} answered HTTP ${status} for its model list. Check that this key’s account has API access.`,
          status,
        );
      if (status === 429)
        return failed(
          'rate_limited',
          `${label} is limiting requests from this key right now (HTTP 429). Wait a minute and try again.`,
          status,
        );
      return failed(
        'provider_error',
        `${label} answered with an error (HTTP ${status}). Try again shortly.`,
        status,
      );
    }
    return { ok: true, body, latency_ms: Math.round(performance.now() - started) };
  }
}

/** The provider and model one service-side model call uses. */
export type ServiceModel = { provider: string; model: string };

/** The job an attempt is claimed for, as far as choosing its model needs it. */
export type ScheduledWorkRow = { id: string; kind: string; spaceId: string };

/**
 * The space a side call is about. It runs on the secondary of that space's
 * owner, never on that of the person speaking or asking.
 */
export type SideCallOwner = { spaceId: string };

/**
 * Where a model call the service makes on its own (memory reads, learning
 * proposals, the companies scan, the action reviewer) takes its model and its
 * credentials from. Both are read for each call, so a model or key the owner
 * connects in the app applies to the next call without a restart.
 */
export type ServiceModelSource = {
  /**
   * The model the next call uses. Told the space the call is about, a short
   * side call runs on the secondary of that space's owner when they chose one.
   */
  current(whose?: SideCallOwner): Promise<ServiceModel>;
  /** The gateway's providers for one call: the configured ones plus keys connected in the app. */
  providers(configured: GatewayProvider[]): Promise<GatewayProvider[]>;
  /** Whether a call to this provider would carry a credential now. */
  connected(provider: string): Promise<boolean>;
  /** Whether this provider is a model server on the owner's machine or network. */
  local(provider: string): Promise<boolean>;
};

/**
 * The one resolver every service-side model call uses. A model the operator
 * set outright for that use (`pinned`, from MELETE_MEMORY_MODEL and the like)
 * wins; then, for a short side call, the secondary model of the person whose
 * work it is about; otherwise the model chosen in the app, else the server's
 * default.
 * Without the settings service (a test, a process with no database) it is the
 * server's default with the configured providers.
 */
export function serviceModelSource(options: {
  env: Pick<Env, 'MELETE_DEFAULT_PROVIDER' | 'MELETE_DEFAULT_MODEL'> & {
    OPENAI_COMPAT_BASE_URL?: string;
  };
  settings?: ModelSettingsService;
  pinned?: { provider?: string; model?: string };
  /**
   * The operator's fast model (MELETE_MODEL_FAST), for a short side call. A
   * model pinned for this use, or the person's own secondary, wins over it; it
   * wins over the default.
   */
  fast?: ServiceModel | null;
  /**
   * These are short side calls, which a person's secondary model takes when
   * they chose one. Implied by passing `fast`, even when it is null. A safety
   * check (the action reviewer) passes false: no person's setting moves it.
   */
  sideTask?: boolean;
}): ServiceModelSource {
  const { env, settings } = options;
  const pinned = options.pinned?.provider || options.pinned?.model ? options.pinned : undefined;
  const sideTask = options.sideTask ?? options.fast !== undefined;
  const local = async (provider: string) =>
    settings
      ? settings.servesLocally(provider)
      : provider === OPENAI_COMPATIBLE && addressIsLocal(env.OPENAI_COMPAT_BASE_URL);
  return {
    async current(whose) {
      if (pinned)
        return {
          provider: pinned.provider || env.MELETE_DEFAULT_PROVIDER,
          model: pinned.model || env.MELETE_DEFAULT_MODEL,
        };
      // The person's own secondary, when this short call is about their work.
      const secondary = sideTask && settings && whose ? await settings.sideTaskModel(whose) : null;
      if (secondary) return secondary;
      const chosen = settings
        ? await settings.activeChoice()
        : { provider: env.MELETE_DEFAULT_PROVIDER, model: env.MELETE_DEFAULT_MODEL };
      // A model on the owner's own machine or network keeps the side calls on
      // it; the fast model is for a cloud model's.
      if (options.fast && !(await local(chosen.provider)))
        return { provider: options.fast.provider, model: options.fast.model };
      return { provider: chosen.provider, model: chosen.model };
    },
    providers: async (configured) => (settings ? settings.providers(configured) : configured),
    connected: async (provider) => (settings ? settings.isConnected(provider) : true),
    local,
  };
}

const INVALID_ADDRESS =
  'Give the endpoint’s http:// or https:// address, without a user name, query or fragment, for example https://models.example.net/v1.';

/** An endpoint address the gateway will accept, as it keeps it; throws otherwise. */
export function checkedBaseUrl(address: string): string {
  let parsed: URL;
  try {
    parsed = new URL(address.trim());
  } catch {
    throw new ServiceError('invalid_address', INVALID_ADDRESS, 400);
  }
  const base = compatibleBaseUrl(`${parsed.origin}${parsed.pathname}`);
  if (parsed.search || parsed.hash || parsed.username || parsed.password)
    throw new ServiceError('invalid_address', INVALID_ADDRESS, 400);
  try {
    providerUrl(openAiCompatibleProvider(base), 'chat/completions');
  } catch {
    throw new ServiceError('invalid_address', INVALID_ADDRESS, 400);
  }
  return base;
}

/** The model ids in an OpenAI-style (`data[].id`) or Gemini-style (`models[].name`) list. */
export function modelIds(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const record = body as { data?: unknown; models?: unknown };
  const entries = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const value =
      (entry as { id?: unknown; name?: unknown }).id ?? (entry as { name?: unknown }).name;
    if (typeof value === 'string' && value && value.length <= 300)
      ids.add(value.replace(/^models\//, ''));
  }
  return [...ids].sort().slice(0, MODEL_LIST_LIMIT);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
