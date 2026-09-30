/**
 * The privacy router: decides where each model request may go and what it may
 * carry, at the one place every request passes (the model gateway).
 *
 * - A request in a space or agent the person marked private, or in a
 *   conversation found sensitive (health, therapy, finances), goes to their
 *   local model unredacted, because it does not leave their machine.
 * - With no local model, it does not go anywhere until the person agrees to a
 *   redacted cloud request: the attempt asks first, and the gateway refuses as
 *   the backstop. There is no silent fallback.
 * - Everything else is redacted with the conversation's vault and sent to the
 *   configured provider; the reply is rehydrated before the engine sees it.
 * - A configured provider that is itself on this machine or network gets the
 *   request as written: nothing leaves.
 */
import {
  type AttemptBundle,
  PRIVACY_CATEGORY_NAMES,
  type PrivacyCategory,
  type PrivacyPreview,
  type PrivacyReceipt,
  type QuestionSpecInput,
  type SensitiveTopic,
} from '@melete/contracts';
import { GatewayError, type GatewayPrincipal, type GatewayProvider } from '../gateway/types.ts';
import { authoredParts, classify, classifyParts, type TopicHits } from './classify.ts';
import type { Detection } from './detect.ts';
import { isLocalUrl, type LocalModel, localDetect } from './local.ts';
import { type Protocol, Redactor } from './redact.ts';
import { type PrivacyStore, type ResolvedSettings, resolveSettings, type Scope } from './store.ts';
import { Rehydrator } from './stream.ts';
import { placeholderCategory, Vault } from './vault.ts';

export type PreparedRequest = {
  body: Record<string, unknown>;
  route: 'cloud' | 'local' | 'on_device';
  /** Set when the request goes to the person's own model instead of the provider. */
  local: LocalModel | null;
  rehydrator: Rehydrator | null;
  receipt: PrivacyReceipt;
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
  settingsVersion: number;
  saving: Promise<void>;
};

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

  async settingsFor(spaceId: string | null): Promise<ResolvedSettings> {
    const key = spaceId ?? '';
    const cached = this.settingsCache.get(key);
    if (cached && Date.now() - cached.at < this.cacheMs) return cached.value;
    const stored = await this.store.settings(spaceId);
    const value = resolveSettings(
      stored.plain,
      stored.sealed,
      stored.version,
      this.options.fallbackLocal ?? null,
    );
    this.settingsCache.set(key, { value, at: Date.now() });
    return value;
  }

  /** A settings change applies to the next request, not after the cache expires. */
  invalidate(spaceId: string) {
    this.settingsCache.delete(spaceId);
  }

  /** Whether every address of this URL is on the person's machine or network. */
  async isLocal(url: string): Promise<boolean> {
    const cached = this.addressChecks.get(url);
    if (cached && Date.now() - cached.at < this.cacheMs) return cached.local;
    const local = await isLocalUrl(url, this.options.resolve);
    this.addressChecks.set(url, { local, at: Date.now() });
    return local;
  }

  private async state(scope: Scope, settings: ResolvedSettings): Promise<ConversationState> {
    const fresh = (vault: Vault | null): ConversationState => ({
      vault: vault ?? new Vault(),
      cache: new Map(),
      ner: new Map(),
      settingsVersion: settings.version,
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
    if (state.settingsVersion !== settings.version) {
      // Categories or listed values changed: the same text may redact differently now.
      state.cache.clear();
      state.settingsVersion = settings.version;
    }
    return state;
  }

  /** The destination and body for one outbound request. Throws to refuse it. */
  async prepare(input: {
    principal: GatewayPrincipal;
    provider: GatewayProvider;
    protocol: Protocol;
    body: Record<string, unknown>;
  }): Promise<PreparedRequest> {
    const { principal, provider, protocol, body } = input;
    const scope = await this.store.scope(principal.jobId, principal.attemptId);
    const settings = await this.settingsFor(scope.spaceId);
    if (!provider.fake && (await this.isLocal(provider.baseUrl))) {
      const receipt = emptyReceipt('on_device');
      await this.log(scope, receipt);
      return { body, route: 'on_device', local: null, rehydrator: null, receipt };
    }
    const decision = await this.privateDecision(scope, settings, authoredParts(body, protocol));
    if (decision.private) {
      const local = settings.local;
      if (local && protocol === 'chat/completions' && (await this.isLocal(local.baseUrl))) {
        const receipt = emptyReceipt('local');
        await this.log(scope, receipt);
        return {
          body: { ...body, model: local.model },
          route: 'local',
          local,
          rehydrator: null,
          receipt,
        };
      }
      if (decision.consent !== 'allowed')
        throw new GatewayError(409, 'privacy_confirmation_required');
    }
    const state = await this.state(scope, settings);
    let localDetection: PrivacyReceipt['local_detection'] = 'off';
    if (settings.localDetection && settings.local)
      localDetection = await this.detectLocally(state, body, protocol, settings.local);
    const redactor = new Redactor(state.vault, {
      enabled: settings.enabled,
      known: settings.known,
      cache: state.cache,
      extra: (text) => state.ner.get(text),
    });
    const redacted = redactor.body(body, protocol);
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
    };
  }

  /** Whether this conversation must stay private, and what the person said about it. */
  private async privateDecision(
    scope: Scope,
    settings: ResolvedSettings,
    authored: { person: string[]; tools: string[] },
  ): Promise<{
    private: boolean;
    sensitive: SensitiveTopic | null;
    consent: 'allowed' | 'declined' | null;
  }> {
    const conversation = scope.conversationId
      ? await this.store.conversation(scope.conversationId)
      : null;
    let sensitive = conversation?.sensitive ?? null;
    if (!sensitive) {
      sensitive = classifyParts(authored, settings.topics, this.topics);
      if (sensitive && scope.conversationId && scope.spaceId)
        await this.store.updateConversation(scope.conversationId, scope.spaceId, { sensitive });
    }
    const agentPrivate = scope.agentId !== null && settings.privateAgents.has(scope.agentId);
    return {
      private: settings.privateSpace || agentPrivate || sensitive !== null,
      sensitive,
      consent: conversation?.consent ?? null,
    };
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
    local: LocalModel,
  ): Promise<'used' | 'failed'> {
    if (!(await this.isLocal(local.baseUrl))) return 'failed';
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
  async beforeAttempt(bundle: AttemptBundle, engineProtocol: Protocol): Promise<GateDecision> {
    const scope = await this.store.scope(bundle.attempt.job_id, bundle.attempt.id);
    if (!scope.conversationId || !scope.spaceId) return { proceed: true };
    const settings = await this.settingsFor(scope.spaceId);
    const person = [
      bundle.job.objective,
      ...bundle.inputs.new_user_messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content),
    ];
    const decision = await this.privateDecision(scope, settings, { person, tools: [] });
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

function declinedText(): string {
  return 'Nothing was sent. To work on this privately, add a local model in Settings → Privacy and ask again.';
}

/** For the settings screen: a readable name per category. */
export const categoryName = (category: PrivacyCategory) => PRIVACY_CATEGORY_NAMES[category];
