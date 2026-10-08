/**
 * The privacy router: decides where each model request may go and what it may
 * carry, at the one place every request passes (the model gateway).
 *
 * - A request in a space or agent the person marked private, or in a
 *   conversation found sensitive (health, therapy, finances) from what the
 *   person wrote there, goes to their local model unredacted, because it does
 *   not leave their machine. What tools brought back never decides that.
 * - With no local model, it does not go anywhere until the person agrees to a
 *   redacted cloud request: the attempt asks first, and the gateway refuses as
 *   the backstop. There is no silent fallback.
 * - Everything else is redacted with the conversation's vault and sent to the
 *   configured provider; the reply is rehydrated before the engine sees it.
 *   What memory learned in private conversations is swapped out of it too.
 * - A configured provider gets the request as written only when the owner has
 *   confirmed its address is a model running on a machine they control. An
 *   address on this machine or network is not enough on its own: a proxy or
 *   gateway there may forward to a cloud service.
 *
 * Every request names whose data it carries (`GatewayPrincipal.privacy`): an
 * engine attempt's own job, or a service call's space and the conversation it
 * read from, so a memory call about a private conversation is routed like that
 * conversation.
 */
import { createHash } from 'node:crypto';
import {
  type AttemptBundle,
  modelSupportsVision,
  type PrivacyCategory,
  type PrivacyPreview,
  type PrivacyReceipt,
  type QuestionSpecInput,
  type SensitiveTopic,
} from '@melete/contracts';
import { countImages, imageMark, inlineImages, withoutImages } from '../gateway/images.ts';
import { GatewayError, type GatewayPrincipal, type GatewayProvider } from '../gateway/types.ts';
import {
  authoredParts,
  classify,
  classifyParts,
  classifyStrong,
  type TopicHits,
} from './classify.ts';
import type { Detection } from './detect.ts';
import { isLocalUrl, type LocalModel, localDetect, pinLocalModel } from './local.ts';
import { type Protocol, Redactor } from './redact.ts';
import {
  type PrivacyStore,
  type ResolvedSettings,
  resolveSettings,
  type Scope,
  type ScreenshotSource,
  sameAddress,
} from './store.ts';
import { Rehydrator } from './stream.ts';
import { type KnownValue, placeholderCategory, Vault } from './vault.ts';

/**
 * What a private conversation's screenshot becomes when the request leaves
 * redacted for a cloud model: a picture cannot have its details swapped for
 * placeholders, so it does not go.
 */
export const IMAGE_WITHHELD_PRIVATE =
  '[A screenshot was taken here. It is not shown to this model because this conversation is private and a picture cannot be redacted.]';

/** The agent's own screenshot, when the owner turned those off for cloud models. */
export const IMAGE_WITHHELD_OWN =
  '[A screenshot of your own computer was taken here. It is not shown to cloud models: that is turned off in Settings > Privacy. The receipt says where it was saved.]';

/** A paired computer's screenshot, unless that computer or the privacy setting allows it. */
export const IMAGE_WITHHELD_DEVICE =
  "[A screenshot of the person's paired computer was taken here. It is not shown to cloud models unless that computer allows it in Settings > Devices. The receipt says where it was saved.]";

/** A picture whose source is not marked, treated as the most private kind. */
export const IMAGE_WITHHELD_UNKNOWN =
  '[A picture was here. It is not shown to cloud models because where it came from is not known.]';

/** What a screenshot becomes for a local model that does not read images. */
export const IMAGE_WITHHELD_LOCAL =
  '[A screenshot was taken here. It is not shown because the local model does not read images.]';

export type PreparedRequest = {
  body: Record<string, unknown>;
  route: 'cloud' | 'local' | 'on_device';
  /** Set when the request goes to the person's own model instead of the provider. */
  local: LocalModel | null;
  rehydrator: Rehydrator | null;
  receipt: PrivacyReceipt;
  /**
   * The conversation must stay private. A cloud request that is still sent
   * went with the person's consent, redacted, and carries no picture or file.
   */
  private?: boolean;
};

export type GateDecision =
  | { proceed: true }
  | { proceed: false; text: string; question: QuestionSpecInput | null };

export type PrivacyRouterOptions = {
  store: PrivacyStore;
  /** A local model set in the environment, used until the person saves their own. */
  fallbackLocal?: LocalModel | null;
  /** Service transport for the local detection pass; tests inject one. */
  fetch?: (request: Request) => Promise<Response>;
  onError?: (error: Error) => void;
  /** Name resolution for the local-address checks; tests inject one. */
  resolve?: (hostname: string) => Promise<{ address: string }[]>;
  /** How long settings and address checks are trusted before they are read again. */
  cacheMs?: number;
};

type ConversationState = {
  vault: Vault;
  cache: Map<string, { text: string; used: string[] }>;
  ner: Map<string, Detection[]>;
  /** The settings version and private memory the cache was built under. */
  settingsVersion: string;
  saving: Promise<void>;
};

/** Why a web search stayed in, in words the model passes on. */
export const SEARCH_KEPT_PRIVATE =
  'This conversation is private, so nothing is searched on the web. Answer from what you already have.';
export const SEARCH_KEPT_TOPIC =
  'This search is about a topic kept private here, so it was not sent to an outside search.';
export const SEARCH_KEPT_DETAILS =
  'This search carries personal details the privacy settings keep from outside services, so it was not sent. Search without them.';

/** Labels of the quick answers; the recorded answer is the label. */
export const SEND_REDACTED = 'Send a redacted version';
export const KEEP_PRIVATE = 'Keep it private';

const TOPIC_WORDS: Record<SensitiveTopic, string> = {
  health: 'health or medical records',
  therapy: 'therapy or mental health',
  finance: 'personal finances',
};

const MAX_CONVERSATIONS = 500;

export class PrivacyRouter {
  private readonly settingsCache = new Map<string, { value: ResolvedSettings; at: number }>();
  private readonly states = new Map<string, Promise<ConversationState>>();
  private readonly addressChecks = new Map<string, { local: boolean; at: number }>();
  /** Topic words per string, read once: a history is re-sent every turn. */
  private readonly topics = new Map<string, TopicHits>();

  constructor(readonly options: PrivacyRouterOptions) {}

  get store(): PrivacyStore {
    return this.options.store;
  }

  private get cacheMs() {
    return this.options.cacheMs ?? 30_000;
  }

  private report(error: unknown) {
    this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
  }

  async settingsFor(
    spaceId: string | null,
    query?: Parameters<PrivacyStore['settings']>[1],
  ): Promise<ResolvedSettings> {
    const key = spaceId ?? '';
    const cached = this.settingsCache.get(key);
    if (cached && Date.now() - cached.at < this.cacheMs) return cached.value;
    const stored = await this.store.settings(spaceId, query);
    const value = resolveSettings(
      stored.plain,
      stored.sealed,
      stored.version,
      this.options.fallbackLocal ?? null,
      stored.installation !== false,
    );
    this.settingsCache.set(key, { value, at: Date.now() });
    return value;
  }

  /**
   * Whether the person marked this space, or this agent in it, private. Read
   * through `query` when the caller holds a transaction.
   */
  async marksPrivate(
    spaceId: string,
    agentId: string | null,
    query?: Parameters<PrivacyStore['settings']>[1],
  ): Promise<boolean> {
    const settings = await this.settingsFor(spaceId, query);
    return settings.privateSpace || (agentId !== null && settings.privateAgents.has(agentId));
  }

  /**
   * Why a web search for this job may not go to an outside search service, or
   * null when it may. A search query leaves Melete as written, with no
   * placeholders, so it is held to more than a model request is: nothing from
   * a private space or agent or a sensitive conversation, nothing about a
   * sensitive topic, and nothing carrying a detail the privacy settings detect.
   */
  async outsideSearchRefusal(jobId: string, query: string): Promise<string | null> {
    const scope = await this.store.scope(jobId, '');
    if (!scope.spaceId) return SEARCH_KEPT_PRIVATE;
    const settings = await this.settingsFor(scope.spaceId);
    if (
      settings.privateSpace ||
      (scope.agentId !== null && settings.privateAgents.has(scope.agentId))
    )
      return SEARCH_KEPT_PRIVATE;
    const conversation = scope.conversationId
      ? await this.store.conversation(scope.conversationId)
      : null;
    if (conversation?.sensitive) return SEARCH_KEPT_PRIVATE;
    // The person said this conversation is not sensitive; the query is not read for a topic.
    if (!conversation?.cleared && classifyParts([query], settings.topics, this.topics))
      return SEARCH_KEPT_TOPIC;
    // The same redactor the gateway runs on a cloud request, over the query as
    // it would leave: this conversation's vault (every detail it has already
    // swapped, local-detector names included, in any spelling), the listed
    // values, what memory learned in private conversations, and the detectors.
    // Anything it would swap means the query carries what no cloud model sees.
    if (/[⟦⟧]/.test(query)) return SEARCH_KEPT_DETAILS;
    const remembered = await this.store.privateMemory(scope.spaceId);
    const state = await this.state(scope, settings, `${settings.version}:${digest(remembered)}`);
    const redactor = new Redactor(state.vault, {
      enabled: settings.enabled,
      known: [...settings.known, ...memoryValues(remembered)],
      extra: (text) => state.ner.get(text),
    });
    if (redactor.spans(query).length > 0) return SEARCH_KEPT_DETAILS;
    return null;
  }

  /**
   * Texts as a cloud embedder may read them, through the same redactor the
   * gateway runs on a cloud request: the listed values, what memory learned in
   * private conversations, the detectors, the local name detector when it is
   * on, and, for a job's own words, that conversation's vault. Null when
   * nothing from the space (or the job's private agent) may leave at all.
   */
  async screenForCloud(
    spaceId: string,
    texts: readonly string[],
    jobId?: string | null,
  ): Promise<string[] | null> {
    const settings = await this.settingsFor(spaceId);
    if (settings.privateSpace) return null;
    let scope: Scope = {
      jobId: '',
      attemptId: '',
      spaceId,
      conversationId: null,
      agentId: null,
      turnId: null,
    };
    if (jobId) {
      const own = await this.store.scope(jobId, '');
      if (own.spaceId !== spaceId) return null;
      if (own.agentId !== null && settings.privateAgents.has(own.agentId)) return null;
      scope = own;
    }
    const remembered = await this.store.privateMemory(spaceId);
    const state = await this.state(scope, settings, `${settings.version}:${digest(remembered)}`);
    if (settings.localDetection && settings.local)
      await this.detectLocally(
        state,
        { messages: texts.map((content) => ({ role: 'user', content })) },
        'chat/completions',
        settings.local,
      );
    const redactor = new Redactor(state.vault, {
      enabled: settings.enabled,
      known: [...settings.known, ...memoryValues(remembered)],
      cache: state.cache,
      extra: (text) => state.ner.get(text),
    });
    return texts.map((text) => redactor.text(text));
  }

  /** A settings change applies to the next request, not after the cache expires. */
  invalidate(spaceId: string) {
    this.settingsCache.delete(spaceId);
  }

  /**
   * Whose data a request carries. An engine attempt is read from its job; a
   * service call is taken at its word for the space, and a conversation it
   * names must exist in that space.
   */
  async scopeFor(principal: GatewayPrincipal): Promise<Scope> {
    const declared = principal.privacy;
    if (declared?.kind === 'job') return this.store.scope(principal.jobId, principal.attemptId);
    if (declared?.kind !== 'service') throw new GatewayError(403, 'privacy_scope_missing');
    const base = {
      jobId: principal.jobId,
      attemptId: principal.attemptId,
      spaceId: declared.spaceId,
      conversationId: null,
      agentId: null,
      turnId: null,
    };
    if (!declared.sourceJobId) return base;
    const source = await this.store.scope(declared.sourceJobId, '');
    if (source.spaceId === null) throw new GatewayError(403, 'privacy_scope_unknown');
    if (source.spaceId !== declared.spaceId) throw new GatewayError(403, 'privacy_scope_mismatch');
    return { ...base, conversationId: source.conversationId, agentId: source.agentId };
  }

  /** Whether every address of this URL is on the person's machine or network. */
  async isLocal(url: string): Promise<boolean> {
    const cached = this.addressChecks.get(url);
    if (cached && Date.now() - cached.at < this.cacheMs) return cached.local;
    const local = await isLocalUrl(url, this.options.resolve);
    this.addressChecks.set(url, { local, at: Date.now() });
    return local;
  }

  private async state(
    scope: Scope,
    settings: ResolvedSettings,
    key = String(settings.version),
  ): Promise<ConversationState> {
    const fresh = (vault: Vault | null): ConversationState => ({
      vault: vault ?? new Vault(),
      cache: new Map(),
      ner: new Map(),
      settingsVersion: key,
      saving: Promise.resolve(),
    });
    // The service's own calls have no conversation: a vault for this request only.
    if (!scope.conversationId) return fresh(null);
    const id = scope.conversationId;
    let pending = this.states.get(id);
    if (!pending) {
      pending = this.store
        .loadVault(id)
        .catch((error) => {
          this.report(error);
          return null;
        })
        .then(fresh);
      this.states.set(id, pending);
      if (this.states.size > MAX_CONVERSATIONS) {
        const oldest = this.states.keys().next().value;
        if (oldest !== undefined) this.states.delete(oldest);
      }
    }
    const state = await pending;
    if (state.settingsVersion !== key) {
      // Categories, listed values or private memory changed: the same text may
      // redact differently now.
      state.cache.clear();
      state.settingsVersion = key;
    }
    return state;
  }

  /**
   * An ordinary conversation's pictures as a cloud model may see them. The
   * agent's own computer and browser go unless the owner turned that off; a
   * paired computer's screen goes only when that computer, or failing its own
   * answer the privacy setting, allows it; a picture of unknown source never.
   */
  private async screenshotsForCloud(
    jobId: string | null,
    settings: ResolvedSettings,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const images = inlineImages(body);
    if (!images.length) return body;
    // A picture names the action it came from; the action says whose screen it
    // is. Only a job's own requests carry its screenshots.
    const sources = new Map<string, ScreenshotSource | null>();
    for (const image of images) {
      const action = imageMark(image);
      if (action && jobId && !sources.has(action))
        sources.set(action, await this.store.screenshotSource(jobId, action));
    }
    return withoutImages(body, (image) => {
      const action = imageMark(image);
      const source = action ? (sources.get(action) ?? null) : null;
      if (source?.kind === 'computer') return settings.screenshotsOwn ? null : IMAGE_WITHHELD_OWN;
      if (source?.kind === 'device')
        return (source.cloudScreenshots ?? settings.screenshotsDevices)
          ? null
          : IMAGE_WITHHELD_DEVICE;
      return IMAGE_WITHHELD_UNKNOWN;
    });
  }

  /** The destination and body for one outbound request. Throws to refuse it. */
  async prepare(input: {
    principal: GatewayPrincipal;
    provider: GatewayProvider;
    protocol: Protocol;
    body: Record<string, unknown>;
  }): Promise<PreparedRequest> {
    const { principal, provider, protocol, body } = input;
    const scope = await this.scopeFor(principal);
    const settings = await this.settingsFor(scope.spaceId);
    if (!provider.fake && (await this.onDevice(settings, provider.baseUrl))) {
      const receipt = emptyReceipt('on_device');
      await this.log(scope, receipt);
      return { body, route: 'on_device', local: null, rehydrator: null, receipt };
    }
    // A job's request is not read for a topic. The engine re-sends earlier
    // tool results (web pages, files, mail) inside its user turn, and none of
    // that is the person's own words; their messages were read before the
    // attempt started. A service call is read for itself and never sets the
    // conversation's topic: what it carries (a memory snapshot, say) is not
    // what the person said there.
    const decision = await this.privateRoute(
      scope,
      settings,
      protocol,
      principal.privacy.kind === 'job' ? [] : authoredParts(body, protocol).person,
    );
    if (decision.private) {
      const local = decision.local;
      if (local) {
        const receipt = emptyReceipt('local');
        await this.log(scope, receipt);
        // The person's own model sees the conversation as it is, pictures
        // included, when it reads them.
        const seen =
          countImages(body) && !modelSupportsVision('openai-compatible', local.model)
            ? withoutImages(body, IMAGE_WITHHELD_LOCAL)
            : body;
        return {
          body: { ...seen, model: local.model },
          route: 'local',
          local,
          rehydrator: null,
          receipt,
        };
      }
      if (decision.refused) throw new GatewayError(409, 'privacy_confirmation_required');
    }
    // Pictures are not redacted: nothing below reads them. In a private
    // conversation the person let go redacted, they stay behind; in an ordinary
    // one each goes only as far as its source's switch allows.
    const outbound = decision.private
      ? withoutImages(body, IMAGE_WITHHELD_PRIVATE)
      : await this.screenshotsForCloud(
          principal.privacy.kind === 'job' ? principal.jobId : null,
          settings,
          body,
        );
    // What memory learned in private conversations is swapped out of the text
    // of every cloud request, wherever it appears: recall already leaves it
    // out, and this catches any other way it could arrive as text. Pictures are
    // not read for it; they follow the screenshot switches above.
    const remembered = scope.spaceId ? await this.store.privateMemory(scope.spaceId) : [];
    const state = await this.state(scope, settings, `${settings.version}:${digest(remembered)}`);
    let localDetection: PrivacyReceipt['local_detection'] = 'off';
    if (settings.localDetection && settings.local)
      localDetection = await this.detectLocally(state, outbound, protocol, settings.local);
    const redactor = new Redactor(state.vault, {
      enabled: settings.enabled,
      known: [...settings.known, ...memoryValues(remembered)],
      cache: state.cache,
      extra: (text) => state.ner.get(text),
    });
    const redacted = withPlaceholderNote(
      redactor.body(outbound, protocol),
      protocol,
      redactor.used,
    );
    const receipt = receiptFor('cloud', redactor.used, localDetection);
    if (state.vault.changed && scope.conversationId && scope.spaceId) {
      state.vault.changed = false;
      const conversationId = scope.conversationId;
      const spaceId = scope.spaceId;
      // Saves are chained per conversation, so an older copy never lands last.
      state.saving = state.saving
        .then(() => this.store.saveVault(conversationId, spaceId, state.vault))
        .catch((error) => this.report(error));
      await state.saving;
    }
    await this.log(scope, receipt);
    return {
      body: redacted,
      route: 'cloud',
      local: null,
      rehydrator: new Rehydrator(state.vault, protocol),
      receipt,
      private: decision.private,
    };
  }

  /**
   * Whether this conversation must stay private, and what the person said
   * about it. `person` is only ever what the person wrote. `messages` are the
   * person's messages with when they wrote them: in a conversation they said
   * is not sensitive, only those written after they said so are read, and
   * only a phrase about themselves marks it again.
   */
  private async privateDecision(
    scope: Scope,
    settings: ResolvedSettings,
    person: readonly string[],
    remember: boolean,
    messages: readonly { content: string; at: string }[] = [],
  ): Promise<{
    private: boolean;
    sensitive: SensitiveTopic | null;
    consent: 'allowed' | 'declined' | null;
  }> {
    const conversation = scope.conversationId
      ? await this.store.conversation(scope.conversationId)
      : null;
    let sensitive = conversation?.sensitive ?? null;
    if (!sensitive && !conversation?.cleared) {
      sensitive = classifyParts(person, settings.topics, this.topics);
      if (remember && sensitive && scope.conversationId && scope.spaceId)
        await this.store.updateConversation(scope.conversationId, scope.spaceId, { sensitive });
    } else if (!sensitive && conversation?.clearedAt && remember) {
      const clearedAt = Date.parse(conversation.clearedAt);
      sensitive = classifyStrong(
        messages
          .filter((message) => Date.parse(message.at) > clearedAt)
          .map((message) => message.content),
        settings.topics,
      );
      if (sensitive && scope.conversationId && scope.spaceId)
        await this.store.markConversation(scope.conversationId, scope.spaceId, sensitive);
    }
    const agentPrivate = scope.agentId !== null && settings.privateAgents.has(scope.agentId);
    return {
      private: settings.privateSpace || agentPrivate || sensitive !== null,
      sensitive,
      consent: conversation?.consent ?? null,
    };
  }

  /**
   * Where a request about this scope's conversation may go once it is not on
   * a confirmed on-device address: anywhere when the conversation is not
   * private, to the local model when one can take it, else to the cloud model
   * redacted only if the person agreed. `refused` means it goes nowhere.
   * Requests and the questions asked ahead of them read this one decision.
   */
  private async privateRoute(
    scope: Scope,
    settings: ResolvedSettings,
    protocol: Protocol,
    person: readonly string[],
  ): Promise<{ private: boolean; local: LocalModel | null; refused: boolean }> {
    const decision = await this.privateDecision(scope, settings, person, false);
    if (!decision.private) return { private: false, local: null, refused: false };
    const local = await this.readyLocal(settings, protocol);
    return { private: true, local, refused: !local && decision.consent !== 'allowed' };
  }

  /**
   * Whether a service read of this job's conversation, such as memory reading
   * what the person just wrote, would be refused now: the conversation is
   * private, no local model can take it, and the person has not agreed to a
   * redacted cloud request. The same decision `prepare` makes for that read,
   * asked before it is sent. `engine` is the model memory reads with.
   */
  async refusesServiceRead(
    jobId: string,
    engine: { protocol: Protocol; providerUrl?: string },
  ): Promise<boolean> {
    const scope = await this.store.scope(jobId, '');
    if (!scope.spaceId || !scope.conversationId) return false;
    const settings = await this.settingsFor(scope.spaceId);
    if (engine.providerUrl && (await this.onDevice(settings, engine.providerUrl))) return false;
    return (await this.privateRoute(scope, settings, engine.protocol, [])).refused;
  }

  /**
   * The configured provider is trusted as the person's own model only when the
   * owner confirmed this exact address and it is still on their machine or network.
   */
  private async onDevice(settings: ResolvedSettings, baseUrl: string): Promise<boolean> {
    if (!settings.onDeviceUrl || !sameAddress(settings.onDeviceUrl, baseUrl)) return false;
    return this.isLocal(baseUrl);
  }

  /** The local model, checked and pinned for this request, or null when it cannot take it. */
  private async readyLocal(
    settings: ResolvedSettings,
    protocol: Protocol,
  ): Promise<LocalModel | null> {
    if (!settings.local || protocol !== 'chat/completions') return null;
    return pinLocalModel(settings.local, this.options.resolve);
  }

  /**
   * Whether an attempt's requests will stay on the person's own model, so what
   * memory learned in private conversations may be recalled into its prompt.
   * Read once before the attempt; the gateway still swaps private memory out of
   * any request that goes to a cloud model.
   */
  async recallsPrivateMemory(
    jobId: string,
    attemptId: string,
    engine: { protocol: Protocol; providerUrl?: string },
  ): Promise<boolean> {
    const scope = await this.store.scope(jobId, attemptId);
    if (!scope.spaceId) return false;
    const settings = await this.settingsFor(scope.spaceId);
    if (engine.providerUrl && (await this.onDevice(settings, engine.providerUrl))) return true;
    const conversation = scope.conversationId
      ? await this.store.conversation(scope.conversationId)
      : null;
    const isPrivate =
      settings.privateSpace ||
      (scope.agentId !== null && settings.privateAgents.has(scope.agentId)) ||
      !!conversation?.sensitive;
    return isPrivate && (await this.readyLocal(settings, engine.protocol)) !== null;
  }

  /**
   * Whether a cloud embedder may read this job's words to recall memory by
   * meaning: not in a space or agent marked private, nor in a conversation
   * found sensitive, nor a request about a sensitive topic. Such a request is
   * recalled by its words alone, on this machine. What is sent is still
   * redacted by the embedder.
   */
  async cloudEmbedsRequest(jobId: string, text = ''): Promise<boolean> {
    const scope = await this.store.scope(jobId, '');
    if (!scope.spaceId) return false;
    const settings = await this.settingsFor(scope.spaceId);
    if (settings.privateSpace) return false;
    if (scope.agentId !== null && settings.privateAgents.has(scope.agentId)) return false;
    const conversation = scope.conversationId
      ? await this.store.conversation(scope.conversationId)
      : null;
    if (conversation?.sensitive) return false;
    // The person said this conversation is not sensitive: it is not read for a topic.
    return !text || Boolean(conversation?.cleared) || classify(text, settings.topics) === null;
  }

  /**
   * Why a message said in a room is private, or null: the room is marked
   * private, or the message is about a sensitive topic. A room message may
   * reach no request at all, so it is read by its room rather than a job.
   */
  async captureOriginInSpace(spaceId: string, text: string): Promise<PrivateOrigin | null> {
    const settings = await this.settingsFor(spaceId);
    if (settings.privateSpace) return 'space';
    return classify(text, settings.topics);
  }

  /**
   * Why what the person said in this job is private, when it is: the space or
   * agent is marked private, or the conversation is about a sensitive topic.
   * Memory records this on what it learns from the message. A topic found here
   * is kept on the conversation, as the router would keep it.
   */
  async captureOrigin(jobId: string, text: string): Promise<PrivateOrigin | null> {
    const scope = await this.store.scope(jobId, '');
    if (!scope.spaceId) return null;
    const settings = await this.settingsFor(scope.spaceId);
    if (settings.privateSpace) return 'space';
    if (scope.agentId !== null && settings.privateAgents.has(scope.agentId)) return 'agent';
    const conversation = scope.conversationId
      ? await this.store.conversation(scope.conversationId)
      : null;
    if (conversation?.sensitive) return conversation.sensitive;
    if (conversation?.cleared) return null;
    const sensitive = classify(text, settings.topics);
    if (sensitive && scope.conversationId)
      await this.store.updateConversation(scope.conversationId, scope.spaceId, { sensitive });
    return sensitive;
  }

  private async log(scope: Scope, receipt: PrivacyReceipt) {
    try {
      await this.store.log({ scope, receipt });
    } catch (error) {
      this.report(error);
    }
  }

  /** Ask the local model about strings it has not read before. */
  private async detectLocally(
    state: ConversationState,
    body: Record<string, unknown>,
    protocol: Protocol,
    configured: LocalModel,
  ): Promise<'used' | 'failed'> {
    const local = await pinLocalModel(configured, this.options.resolve);
    if (!local) return 'failed';
    const parts = authoredParts(body, protocol);
    const authored = new Set([...parts.person, ...parts.tools]);
    const strings = [...authored].filter((text) => text.length >= 8 && !state.ner.has(text));
    if (!strings.length) return 'used';
    const found = await localDetect(local, strings, this.options.fetch);
    if (!found) return 'failed';
    for (const [text, spans] of found) state.ner.set(text, spans);
    return 'used';
  }

  /**
   * Before an attempt starts: ask the person when this conversation must stay
   * private and there is no local model to keep it on.
   */
  async beforeAttempt(
    bundle: AttemptBundle,
    engineProtocol: Protocol,
    providerUrl?: string,
  ): Promise<GateDecision> {
    const scope = await this.store.scope(bundle.attempt.job_id, bundle.attempt.id);
    if (!scope.conversationId || !scope.spaceId) return { proceed: true };
    const settings = await this.settingsFor(scope.spaceId);
    // A model the owner confirmed they run takes private conversations as written.
    if (providerUrl && (await this.onDevice(settings, providerUrl))) return { proceed: true };
    const messages = bundle.inputs.new_user_messages.filter((message) => message.role === 'user');
    const person = [bundle.job.objective, ...messages.map((message) => message.content)];
    const decision = await this.privateDecision(scope, settings, person, true, messages);
    if (!decision.private) return { proceed: true };
    const local = settings.local;
    const localReady =
      !!local && engineProtocol === 'chat/completions' && (await this.isLocal(local.baseUrl));
    if (localReady || decision.consent === 'allowed') return { proceed: true };
    const conversation = await this.store.conversation(scope.conversationId);
    if (conversation.askedAttemptId) {
      const answer = await this.store.answer(conversation.askedAttemptId);
      if (answer === SEND_REDACTED) {
        await this.store.updateConversation(scope.conversationId, scope.spaceId, {
          consent: 'allowed',
          askedAttemptId: null,
        });
        return { proceed: true };
      }
      if (answer === KEEP_PRIVATE) {
        await this.store.updateConversation(scope.conversationId, scope.spaceId, {
          consent: 'declined',
          consentTurnId: scope.turnId,
          askedAttemptId: null,
        });
        return { proceed: false, text: declinedText(), question: null };
      }
    }
    if (conversation.consent === 'declined' && conversation.consentTurnId === scope.turnId)
      return { proceed: false, text: declinedText(), question: null };
    await this.store.updateConversation(scope.conversationId, scope.spaceId, {
      askedAttemptId: bundle.attempt.id,
    });
    const why = decision.sensitive
      ? `This conversation looks like it is about ${TOPIC_WORDS[decision.sensitive]}.`
      : settings.privateSpace
        ? 'This space is marked private.'
        : 'This agent is marked private.';
    const missing = local
      ? engineProtocol === 'chat/completions'
        ? 'Your local model is not answering at the address in Settings → Privacy'
        : 'Your local model cannot take this kind of request'
      : 'There is no local model set up in Settings → Privacy';
    const text = `${why} ${missing}, so Melete has not sent anything. It can send a redacted version to the cloud model instead: account and card numbers, IDs, contact details, keys and the details you listed are swapped for placeholders, but the rest of the text goes as written.`;
    return {
      proceed: false,
      text,
      question: {
        text,
        because: [`job:${bundle.attempt.job_id}`],
        if_ignored: 'Nothing is sent to a cloud model until you answer.',
        blocks_external_effect: false,
        options: [
          { id: 'send_redacted', label: SEND_REDACTED },
          { id: 'keep_private', label: KEEP_PRIVATE },
        ],
      },
    };
  }

  /**
   * The broker's second line: placeholders still present in a payload the
   * runtime proposes are resolved against the conversation vault before the
   * payload is canonicalised. An unknown placeholder is reported, never sent.
   */
  async resolvePayload(
    jobId: string,
    attemptId: string,
    value: unknown,
  ): Promise<{ value: unknown; unknown: string[]; resolved: number }> {
    if (!JSON.stringify(value).includes('⟦')) return { value, unknown: [], resolved: 0 };
    const scope = await this.store.scope(jobId, attemptId);
    const vault = scope.conversationId
      ? (await this.state(scope, await this.settingsFor(scope.spaceId))).vault
      : new Vault();
    const unknown = new Set<string>();
    let resolved = 0;
    const walk = (node: unknown): unknown => {
      if (typeof node === 'string')
        return node.replace(/⟦([A-Z][A-Z_]*_\d{1,6})⟧/g, (whole) => {
          const real = vault.value(whole);
          if (real === undefined) {
            unknown.add(whole);
            return whole;
          }
          resolved++;
          return real;
        });
      if (Array.isArray(node)) return node.map(walk);
      if (node && typeof node === 'object')
        return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
      return node;
    };
    return { value: walk(value), unknown: [...unknown], resolved };
  }

  /** What a cloud model would be sent for this text, with a vault that is thrown away. */
  async preview(spaceId: string, text: string, agentId?: string): Promise<PrivacyPreview> {
    const settings = await this.settingsFor(spaceId);
    const sensitive = classify(text, settings.topics);
    const isPrivate =
      settings.privateSpace ||
      (agentId !== undefined && settings.privateAgents.has(agentId)) ||
      sensitive !== null;
    const local = settings.local && (await this.isLocal(settings.local.baseUrl));
    const redactor = new Redactor(new Vault(), {
      enabled: settings.enabled,
      known: settings.known,
    });
    // Placeholder-shaped text in the input is neutralised, as it is for a real request.
    const source = text.replace(/[⟦⟧]/g, (char) => (char === '⟦' ? '⟪' : '⟫'));
    let extra: Detection[] = [];
    if (settings.localDetection && settings.local && local)
      extra = (await localDetect(settings.local, [source], this.options.fetch))?.get(source) ?? [];
    const base = redactor.spans(source);
    const spans = [
      ...base,
      ...extra.filter(
        (span) => !base.some((other) => span.start < other.end && other.start < span.end),
      ),
    ].sort((a, b) => a.start - b.start);
    let sent = '';
    let cursor = 0;
    const details: PrivacyPreview['details'] = [];
    for (const span of spans) {
      sent += source.slice(cursor, span.start);
      const placeholder = redactor.vault.assign(span.category, source.slice(span.start, span.end));
      sent += placeholder;
      details.push({ placeholder, category: span.category, start: span.start, end: span.end });
      cursor = span.end;
    }
    sent += source.slice(cursor);
    return {
      sent,
      route: isPrivate ? (local ? 'local' : 'ask') : 'cloud',
      sensitive,
      details,
    };
  }

  /** Per answer: how many details were swapped and where the requests went. */
  async conversationTurns(conversationId: string) {
    const rows = await this.store.turns(conversationId);
    const byTurn = new Map<string, { routes: Set<string>; placeholders: Set<string> }>();
    for (const row of rows) {
      const entry = byTurn.get(row.turnId) ?? { routes: new Set(), placeholders: new Set() };
      entry.routes.add(row.route);
      for (const placeholder of row.placeholders) entry.placeholders.add(placeholder);
      byTurn.set(row.turnId, entry);
    }
    return [...byTurn].map(([turnId, entry]) => {
      const counts = new Map<PrivacyCategory, number>();
      for (const placeholder of entry.placeholders) {
        const category = placeholderCategory(placeholder);
        if (category) counts.set(category, (counts.get(category) ?? 0) + 1);
      }
      const routes = [...entry.routes];
      return {
        turn_id: turnId,
        protected: entry.placeholders.size,
        categories: [...counts].map(([category, count]) => ({ category, count })),
        route: (routes.length === 1 ? routes[0] : 'mixed') as
          | 'cloud'
          | 'local'
          | 'mixed'
          | 'on_device',
      };
    });
  }

  /** The real values behind one answer's placeholders, for the person's own screen. */
  async reveal(conversationId: string, spaceId: string, turnId: string) {
    const rows = (await this.store.turns(conversationId)).filter((row) => row.turnId === turnId);
    const wanted = new Set(rows.flatMap((row) => row.placeholders));
    if (!wanted.size) return { items: [] };
    const state = await this.state(
      { jobId: conversationId, attemptId: '', spaceId, conversationId, agentId: null, turnId },
      await this.settingsFor(spaceId),
    );
    return {
      items: [...wanted].flatMap((placeholder) => {
        const entry = state.vault.entry(placeholder);
        return entry ? [{ placeholder, category: entry.category, value: entry.value }] : [];
      }),
    };
  }

  /** Forget cached state for a conversation, so the next request reads the store. */
  forget(conversationId: string) {
    this.states.delete(conversationId);
  }
}

/** Why a message is private, as memory records it on what it learns. */
export type PrivateOrigin = 'space' | 'agent' | SensitiveTopic;

/** Private memory as values the redactor swaps, in both its plain and JSON-escaped spelling. */
function memoryValues(contents: string[]): KnownValue[] {
  return contents.flatMap((content, index) => {
    const escaped = JSON.stringify(content).slice(1, -1);
    const spellings = escaped === content ? [content] : [content, escaped];
    return spellings.map((value) => ({
      id: `memory_${index}`,
      label: 'Learned in a private conversation',
      category: 'private' as const,
      value,
    }));
  });
}

function digest(values: string[]): string {
  return values.length ? createHash('sha256').update(values.join('\u0000')).digest('hex') : '';
}

function emptyReceipt(route: PrivacyReceipt['route']): PrivacyReceipt {
  return { route, protected: 0, categories: {}, placeholders: [] };
}

function receiptFor(
  route: PrivacyReceipt['route'],
  used: Set<string>,
  localDetection: PrivacyReceipt['local_detection'],
): PrivacyReceipt {
  const categories: Record<string, number> = {};
  for (const placeholder of used) {
    const category = placeholderCategory(placeholder);
    if (category) categories[category] = (categories[category] ?? 0) + 1;
  }
  return {
    route,
    protected: used.size,
    categories,
    placeholders: [...used],
    ...(localDetection && localDetection !== 'off' ? { local_detection: localDetection } : {}),
  };
}

/**
 * What a placeholder is, said to the model whenever a request carries one. Without it some
 * models read ⟦EMAIL_1⟧ as a blank to fill and ask the person for the "actual" value. Replies,
 * tool-call arguments included, are rehydrated from this conversation's vault on the way back,
 * so the placeholder itself is what the model should write. The example is a placeholder this
 * request already carries; no value is named.
 */
export function placeholderNote(example: string): string {
  return `Some details here appear as placeholders such as ${example}. Each one stands for a real value the person gave, which Melete holds. Use a placeholder exactly as written wherever its value belongs, in replies and in tool-call arguments such as a recipient: Melete puts the real value back before anything is shown or sent. Never ask the person for the value behind a placeholder.`;
}

/** The request with the placeholder note at the end of its system instructions. */
function withPlaceholderNote(
  body: Record<string, unknown>,
  protocol: Protocol,
  used: ReadonlySet<string>,
): Record<string, unknown> {
  const [example] = used;
  if (!example) return body;
  const note = placeholderNote(example);
  const appended = (system: unknown): unknown => {
    if (typeof system === 'string')
      return system
        ? `${system}

${note}`
        : note;
    if (Array.isArray(system)) return [...system, { type: 'text', text: note }];
    return note;
  };
  if (protocol === 'messages') return { ...body, system: appended(body.system) };
  if (protocol === 'responses')
    return {
      ...body,
      instructions: Array.isArray(body.instructions)
        ? [...body.instructions, { role: 'developer', content: note }]
        : appended(body.instructions),
    };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const first = messages[0] as { role?: unknown; content?: unknown } | undefined;
  if (first && (first.role === 'system' || first.role === 'developer'))
    return {
      ...body,
      messages: [
        {
          ...first,
          content: Array.isArray(first.content)
            ? appended(first.content)
            : appended(typeof first.content === 'string' ? first.content : ''),
        },
        ...messages.slice(1),
      ],
    };
  return { ...body, messages: [{ role: 'system', content: note }, ...messages] };
}

function declinedText(): string {
  return 'Nothing was sent. To work on this privately, add a local model in Settings → Privacy and ask again.';
}
