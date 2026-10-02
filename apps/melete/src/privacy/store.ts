/**
 * Where the router's state lives: the person's settings, each conversation's
 * sealed vault, whether a conversation is sensitive and what the person said,
 * and the per-request audit rows.
 *
 * Sealing uses the service's master key through `SealedSecretStore`, bound to
 * the row it belongs to, so a vault copied onto another conversation does not
 * open. Without a master key nothing sensitive is written: vaults stay in memory
 * and the person's listed values cannot be saved.
 */
import { randomUUID } from 'node:crypto';
import {
  PRIVACY_CATEGORIES,
  type PrivacyCategory,
  type PrivacyReceipt,
  SENSITIVE_TOPICS,
  type SensitiveTopic,
} from '@melete/contracts';
import type { Sql, TransactionSql } from 'postgres';
import { SealedSecretStore, type SecretRepository } from '../connectors/secrets.ts';
import type { LocalModel } from './local.ts';
import { type KnownValue, Vault, type VaultData } from './vault.ts';

/** The choices a person makes, resolved against the defaults. */
export type ResolvedSettings = {
  version: number;
  enabled: Set<PrivacyCategory>;
  topics: SensitiveTopic[];
  privateSpace: boolean;
  privateAgents: Set<string>;
  local: LocalModel | null;
  localDetection: boolean;
  known: KnownValue[];
  /**
   * The provider address the owner confirmed is a model they run on this
   * machine or network, not a proxy to a cloud service. Requests to exactly this
   * address are sent as written; nothing else is trusted as local.
   */
  onDeviceUrl: string | null;
  /** Cloud models may see the agent's own computer and browser. On unless turned off. */
  screenshotsOwn: boolean;
  /** Cloud models may see paired computers' screens. Off unless turned on. */
  screenshotsDevices: boolean;
};

/** What is stored in the plain `settings` column. */
export type PlainSettings = {
  enabled?: PrivacyCategory[];
  sensitive_topics?: SensitiveTopic[];
  private_space?: boolean;
  private_agent_ids?: string[];
  local_model?: { base_url: string; model: string } | null;
  local_detection?: boolean;
  /** The provider address the owner confirmed runs on a machine they control. */
  model_on_device_url?: string | null;
  screenshots_own_computer?: boolean;
  screenshots_paired_devices?: boolean;
};

/** What is sealed beside it. */
export type SealedSettings = { known: KnownValue[]; local_api_key?: string };

export function resolveSettings(
  plain: PlainSettings,
  sealed: SealedSettings | null,
  version: number,
  fallbackLocal: LocalModel | null,
): ResolvedSettings {
  const enabled = (plain.enabled ?? [...PRIVACY_CATEGORIES]).filter((category) =>
    PRIVACY_CATEGORIES.includes(category),
  );
  const local =
    plain.local_model === null
      ? null
      : plain.local_model
        ? {
            baseUrl: plain.local_model.base_url,
            model: plain.local_model.model,
            ...(sealed?.local_api_key ? { apiKey: sealed.local_api_key } : {}),
          }
        : fallbackLocal;
  return {
    version,
    enabled: new Set(enabled),
    topics: (plain.sensitive_topics ?? [...SENSITIVE_TOPICS]).filter((topic) =>
      SENSITIVE_TOPICS.includes(topic),
    ),
    privateSpace: plain.private_space === true,
    privateAgents: new Set(plain.private_agent_ids ?? []),
    local,
    localDetection: plain.local_detection === true,
    known: sealed?.known ?? [],
    onDeviceUrl: plain.model_on_device_url ?? null,
    screenshotsOwn: plain.screenshots_own_computer !== false,
    screenshotsDevices: plain.screenshots_paired_devices === true,
  };
}

/** Whether two provider addresses are the same, however each is written. */
export function sameAddress(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    const path = (url: URL) => url.pathname.replace(/\/+$/, '');
    return left.origin === right.origin && path(left) === path(right);
  } catch {
    return false;
  }
}

/** Who a model request belongs to. */
export type Scope = {
  jobId: string;
  attemptId: string;
  spaceId: string | null;
  conversationId: string | null;
  agentId: string | null;
  turnId: string | null;
};

export type ConversationState = {
  sensitive: SensitiveTopic | null;
  /**
   * The person said this conversation is not sensitive. What was there then is
   * not judged again; a phrase about themselves written later still is.
   */
  cleared: boolean;
  /** When they said so, when it is known. */
  clearedAt: string | null;
  consent: 'allowed' | 'declined' | null;
  consentTurnId: string | null;
  askedAttemptId: string | null;
};

export type RequestLog = {
  scope: Scope;
  receipt: PrivacyReceipt;
};

export interface PrivacyStore {
  readonly sealing: boolean;
  scope(jobId: string, attemptId: string): Promise<Scope>;
  /**
   * `query` is the transaction a caller holds, read through instead of a
   * connection of the store's own: a caller holding the event order lock must
   * not wait for another connection.
   */
  settings(
    spaceId: string | null,
    query?: Sql | TransactionSql,
  ): Promise<{ plain: PlainSettings; sealed: SealedSettings | null; version: number }>;
  saveSettings(
    spaceId: string,
    plain: PlainSettings,
    sealed: SealedSettings | null,
  ): Promise<number>;
  loadVault(conversationId: string): Promise<Vault | null>;
  saveVault(conversationId: string, spaceId: string, vault: Vault): Promise<void>;
  conversation(conversationId: string): Promise<ConversationState>;
  /**
   * Change only the named fields. `sensitive` is never cleared here once set:
   * a write that carries none, or races another, leaves it as it was. Only the
   * person changes it, through `markConversation`.
   */
  updateConversation(
    conversationId: string,
    spaceId: string,
    change: Partial<Omit<ConversationState, 'cleared' | 'clearedAt'>>,
  ): Promise<void>;
  /**
   * The person's own word on a conversation: a topic marks it sensitive, null
   * clears a verdict they say is wrong and keeps it from being judged again.
   * Either way an earlier answer to the privacy question no longer applies;
   * a question still open stays the conversation's, so answering it is still
   * recorded as a decision.
   */
  markConversation(
    conversationId: string,
    spaceId: string,
    sensitive: SensitiveTopic | null,
  ): Promise<void>;
  /**
   * Withdraw "send a redacted version" answers given before the space, or one
   * of these agents, was marked private, so the new reason asks again. Null
   * agents means every conversation in the space.
   */
  revokeConsent(spaceId: string, agentIds: string[] | null): Promise<void>;
  /**
   * The current wording of what memory learned from conversations that were
   * private when they were captured, so a cloud request can leave it out.
   */
  privateMemory(spaceId: string): Promise<string[]>;
  /**
   * A paired computer's own answer to whether cloud models may see its screen,
   * or null when it has none. Null too for a computer outside this space.
   */
  deviceCloudScreenshots(spaceId: string, deviceId: string): Promise<boolean | null>;
  /** The answer given to the question an attempt asked, or null while it is open. */
  answer(attemptId: string): Promise<string | null>;
  log(entry: RequestLog): Promise<void>;
  turns(
    conversationId: string,
  ): Promise<{ turnId: string; route: string; placeholders: string[] }[]>;
  /** The conversation this job belongs to, when it is in this space and the caller may read it. */
  ownsConversation(
    spaceId: string,
    conversationId: string,
    principalId?: string | null,
  ): Promise<boolean>;
  /** The person whose conversation this is: who started it, or the installation's owner. */
  conversationPerson(conversationId: string): Promise<string | null>;
}

/** Stored in place of a topic when the person cleared one: "once found, stays found" keeps it. */
const CLEARED = 'none';

const EMPTY_CONVERSATION: ConversationState = {
  sensitive: null,
  cleared: false,
  clearedAt: null,
  consent: null,
  consentTurnId: null,
  askedAttemptId: null,
};

/** Seal a JSON value to one row with the service's master key. */
function sealer(masterKey: () => string | undefined) {
  return {
    async seal(binding: string, value: unknown): Promise<string> {
      let written: string | undefined;
      const one: SecretRepository = {
        put: async (id, _space, ciphertext) => {
          written = JSON.stringify({ id, ciphertext });
        },
        get: async () => null,
      };
      await new SealedSecretStore(one, masterKey).put(binding, JSON.stringify(value));
      if (!written) throw new Error('Sealing failed');
      return written;
    },
    async open<T>(binding: string, stored: string): Promise<T> {
      const { id, ciphertext } = JSON.parse(stored) as { id: string; ciphertext: string };
      const one: SecretRepository = {
        put: async () => {},
        get: async (wanted) => (wanted === id ? ciphertext : null),
      };
      return new SealedSecretStore(one, masterKey).withSecret(id, binding, async (value) =>
        JSON.parse(value),
      ) as Promise<T>;
    },
  };
}

const settingsBinding = (spaceId: string) => `privacy-settings:${spaceId}`;
const vaultBinding = (conversationId: string) => `privacy-vault:${conversationId}`;

export class PostgresPrivacyStore implements PrivacyStore {
  private readonly box: ReturnType<typeof sealer>;

  constructor(
    private readonly sql: Sql,
    private readonly masterKey: () => string | undefined = () => process.env.MELETE_MASTER_KEY,
  ) {
    this.box = sealer(masterKey);
  }

  get sealing(): boolean {
    return !!this.masterKey();
  }

  async scope(jobId: string, attemptId: string): Promise<Scope> {
    const [row] = await this
      .sql`select j.space_id, coalesce(j.experience_parent_id, j.id) as conversation_id,
        coalesce(j.agent_id, p.agent_id) as agent_id, a.turn_id
      from job j
      left join job p on p.id = j.experience_parent_id
      left join attempt a on a.id = ${attemptId} and a.job_id = j.id
      where j.id = ${jobId}`;
    if (row)
      return {
        jobId,
        attemptId,
        spaceId: String(row.space_id),
        conversationId: String(row.conversation_id),
        agentId: row.agent_id ? String(row.agent_id) : null,
        turnId: row.turn_id ? String(row.turn_id) : null,
      };
    return { jobId, attemptId, spaceId: null, conversationId: null, agentId: null, turnId: null };
  }

  async settings(spaceId: string | null, query?: Sql | TransactionSql) {
    if (!spaceId) return { plain: {}, sealed: null, version: 0 };
    const [row] = await (query ??
      this.sql)`select settings, sealed, version from privacy_settings where space_id = ${spaceId}`;
    if (!row) return { plain: {}, sealed: null, version: 0 };
    let sealed: SealedSettings | null = null;
    if (row.sealed && this.sealing) {
      try {
        sealed = await this.box.open<SealedSettings>(settingsBinding(spaceId), String(row.sealed));
      } catch {
        // A row sealed under another key reads as no listed values, never as plaintext.
        sealed = null;
      }
    }
    return { plain: (row.settings ?? {}) as PlainSettings, sealed, version: Number(row.version) };
  }

  async saveSettings(spaceId: string, plain: PlainSettings, sealed: SealedSettings | null) {
    const ciphertext =
      sealed && (sealed.known.length || sealed.local_api_key)
        ? await this.box.seal(settingsBinding(spaceId), sealed)
        : null;
    const [row] = await this.sql`insert into privacy_settings (space_id, settings, sealed)
      values (${spaceId}, ${JSON.stringify(plain)}::jsonb, ${ciphertext})
      on conflict (space_id) do update set settings = excluded.settings, sealed = excluded.sealed,
        version = privacy_settings.version + 1, updated_at = now()
      returning version`;
    return Number(row?.version ?? 1);
  }

  async loadVault(conversationId: string): Promise<Vault | null> {
    if (!this.sealing) return null;
    const [row] = await this
      .sql`select sealed from privacy_vault where conversation_id = ${conversationId}`;
    if (!row) return null;
    try {
      return new Vault(
        await this.box.open<VaultData>(vaultBinding(conversationId), String(row.sealed)),
      );
    } catch {
      return null;
    }
  }

  async saveVault(conversationId: string, spaceId: string, vault: Vault): Promise<void> {
    if (!this.sealing) return;
    const ciphertext = await this.box.seal(vaultBinding(conversationId), vault.toJSON());
    await this.sql`insert into privacy_vault (conversation_id, space_id, sealed, entries)
      values (${conversationId}, ${spaceId}, ${ciphertext}, ${vault.size})
      on conflict (conversation_id) do update set sealed = excluded.sealed,
        entries = excluded.entries, updated_at = now()`;
  }

  async conversation(conversationId: string): Promise<ConversationState> {
    const [row] = await this.sql`select sensitive, cleared_at, consent, consent_turn_id,
        asked_attempt_id
      from privacy_conversation where conversation_id = ${conversationId}`;
    if (!row) return { ...EMPTY_CONVERSATION };
    return {
      sensitive:
        row.sensitive && row.sensitive !== CLEARED ? (row.sensitive as SensitiveTopic) : null,
      cleared: row.sensitive === CLEARED,
      clearedAt:
        row.sensitive === CLEARED && row.cleared_at
          ? new Date(row.cleared_at as string | Date).toISOString()
          : null,
      consent: (row.consent as ConversationState['consent']) ?? null,
      consentTurnId: row.consent_turn_id ? String(row.consent_turn_id) : null,
      askedAttemptId: row.asked_attempt_id ? String(row.asked_attempt_id) : null,
    };
  }

  async updateConversation(
    conversationId: string,
    spaceId: string,
    change: Partial<Omit<ConversationState, 'cleared' | 'clearedAt'>>,
  ): Promise<void> {
    // One statement that touches only the named columns, so two writers (the
    // gate recording a question, the router marking the topic) cannot undo each
    // other, and a topic once found stays found.
    const has = (field: keyof typeof change) => field in change;
    await this.sql`insert into privacy_conversation
        (conversation_id, space_id, sensitive, consent, consent_turn_id, asked_attempt_id)
      values (${conversationId}, ${spaceId}, ${change.sensitive ?? null}, ${change.consent ?? null},
        ${change.consentTurnId ?? null}, ${change.askedAttemptId ?? null})
      on conflict (conversation_id) do update set
        sensitive = coalesce(privacy_conversation.sensitive, excluded.sensitive),
        consent = case when ${has('consent')} then excluded.consent
          else privacy_conversation.consent end,
        consent_turn_id = case when ${has('consentTurnId')} then excluded.consent_turn_id
          else privacy_conversation.consent_turn_id end,
        asked_attempt_id = case when ${has('askedAttemptId')} then excluded.asked_attempt_id
          else privacy_conversation.asked_attempt_id end,
        updated_at = now()`;
  }

  async markConversation(
    conversationId: string,
    spaceId: string,
    sensitive: SensitiveTopic | null,
  ): Promise<void> {
    const value = sensitive ?? CLEARED;
    const clearedAt = sensitive === null ? this.sql`now()` : null;
    await this.sql`insert into privacy_conversation
        (conversation_id, space_id, sensitive, cleared_at)
      values (${conversationId}, ${spaceId}, ${value}, ${clearedAt})
      on conflict (conversation_id) do update set sensitive = excluded.sensitive,
        cleared_at = excluded.cleared_at, consent = null, consent_turn_id = null,
        updated_at = now()`;
  }

  async revokeConsent(spaceId: string, agentIds: string[] | null): Promise<void> {
    if (agentIds && !agentIds.length) return;
    await this.sql`update privacy_conversation pc set consent = null, consent_turn_id = null,
        updated_at = now()
      where pc.space_id = ${spaceId} and pc.consent = 'allowed'
        and (${agentIds === null} or exists (
          select 1 from job j left join job p on p.id = j.experience_parent_id
          where j.id = pc.conversation_id
            and coalesce(j.agent_id, p.agent_id) = any(${agentIds ?? []}::text[])))`;
  }

  async privateMemory(spaceId: string): Promise<string[]> {
    const rows = await this.sql`select distinct b.content from memory_claims c
      join memory_revision_content b on b.claim_id = c.id and b.revision = c.head_revision
      where c.space_id = ${spaceId} and not c.hidden and exists (
        select 1 from memory_references ref join memory_sources s on s.id = ref.source_id
        where ref.claim_id = c.id and ref.revision = c.head_revision
          and s.private_origin is not null)
      limit 500`;
    return rows.map((row) => String(row.content));
  }

  async deviceCloudScreenshots(spaceId: string, deviceId: string): Promise<boolean | null> {
    const [row] = await this.sql`select cloud_screenshots from paired_device
      where id = ${deviceId} and space_id = ${spaceId}`;
    const value = row?.cloud_screenshots;
    return typeof value === 'boolean' ? value : null;
  }

  async answer(attemptId: string): Promise<string | null> {
    const [row] = await this.sql`select answer from question
      where attempt_id = ${attemptId} and state = 'answered' order by created_at desc limit 1`;
    return row?.answer ? String(row.answer) : null;
  }

  async log({ scope, receipt }: RequestLog): Promise<void> {
    await this.sql`insert into privacy_request (space_id, conversation_id, job_id, attempt_id,
        turn_id, route, protected, categories, placeholders, local_detection)
      values (${scope.spaceId}, ${scope.conversationId}, ${scope.jobId}, ${scope.attemptId},
        ${scope.turnId}, ${receipt.route}, ${receipt.protected},
        ${JSON.stringify(receipt.categories)}::jsonb, ${JSON.stringify(receipt.placeholders)}::jsonb,
        ${receipt.local_detection ?? null})`;
  }

  async turns(conversationId: string) {
    const rows = await this.sql`select turn_id, route, placeholders from privacy_request
      where conversation_id = ${conversationId} and turn_id is not null order by id`;
    return rows.map((row) => ({
      turnId: String(row.turn_id),
      route: String(row.route),
      placeholders: (row.placeholders as string[]) ?? [],
    }));
  }

  async ownsConversation(spaceId: string, conversationId: string, principalId?: string | null) {
    const [row] = await this.sql`select principal_id from job
      where id = ${conversationId} and space_id = ${spaceId}`;
    if (!row) return false;
    return principalId === undefined || !row.principal_id || row.principal_id === principalId;
  }

  async conversationPerson(conversationId: string) {
    const [row] = await this.sql`select coalesce(principal_id, (select id from owner limit 1))
        as person
      from job where id = ${conversationId}`;
    return row?.person ? String(row.person) : null;
  }
}

/** For tests and for a service without a database: everything in memory. */
export class MemoryPrivacyStore implements PrivacyStore {
  readonly sealing = true;
  constructor(private readonly options: { keepLogs?: boolean } = {}) {}
  readonly vaults = new Map<string, VaultData>();
  readonly logs: RequestLog[] = [];
  readonly conversations = new Map<string, ConversationState>();
  readonly answers = new Map<string, string>();
  /** What memory learned privately, per space. */
  readonly memory = new Map<string, string[]>();
  readonly scopes = new Map<string, Omit<Scope, 'jobId' | 'attemptId'>>();
  private readonly stored = new Map<
    string,
    { plain: PlainSettings; sealed: SealedSettings | null; version: number }
  >();

  async scope(jobId: string, attemptId: string): Promise<Scope> {
    const known = this.scopes.get(jobId);
    return {
      jobId,
      attemptId,
      spaceId: known?.spaceId ?? null,
      conversationId: known?.conversationId ?? null,
      agentId: known?.agentId ?? null,
      turnId: known?.turnId ?? null,
    };
  }

  async settings(spaceId: string | null) {
    return (spaceId && this.stored.get(spaceId)) || { plain: {}, sealed: null, version: 0 };
  }

  async saveSettings(spaceId: string, plain: PlainSettings, sealed: SealedSettings | null) {
    const version = (this.stored.get(spaceId)?.version ?? 0) + 1;
    this.stored.set(spaceId, { plain, sealed, version });
    return version;
  }

  async loadVault(conversationId: string) {
    const data = this.vaults.get(conversationId);
    return data ? new Vault(structuredClone(data)) : null;
  }

  async saveVault(conversationId: string, _spaceId: string, vault: Vault) {
    this.vaults.set(conversationId, structuredClone(vault.toJSON()));
  }

  async conversation(conversationId: string) {
    return { ...(this.conversations.get(conversationId) ?? EMPTY_CONVERSATION) };
  }

  async updateConversation(
    conversationId: string,
    _spaceId: string,
    change: Partial<Omit<ConversationState, 'cleared' | 'clearedAt'>>,
  ) {
    const current = await this.conversation(conversationId);
    this.conversations.set(conversationId, {
      ...current,
      ...change,
      sensitive: current.cleared ? null : (current.sensitive ?? change.sensitive ?? null),
    });
  }

  async markConversation(
    conversationId: string,
    _spaceId: string,
    sensitive: SensitiveTopic | null,
  ) {
    const current = await this.conversation(conversationId);
    this.conversations.set(conversationId, {
      ...current,
      sensitive,
      cleared: sensitive === null,
      clearedAt: sensitive === null ? new Date().toISOString() : null,
      consent: null,
      consentTurnId: null,
    });
  }

  async revokeConsent(spaceId: string, agentIds: string[] | null) {
    for (const [conversationId, state] of this.conversations) {
      if (state.consent !== 'allowed') continue;
      const scope = [...this.scopes.values()].find(
        (entry) => entry.conversationId === conversationId,
      );
      if (scope && scope.spaceId !== spaceId) continue;
      if (agentIds !== null && !(scope?.agentId && agentIds.includes(scope.agentId))) continue;
      this.conversations.set(conversationId, { ...state, consent: null, consentTurnId: null });
    }
  }

  async privateMemory(spaceId: string) {
    return this.memory.get(spaceId) ?? [];
  }

  /** Paired computers' own screenshot answers, keyed `space:device`. */
  readonly deviceScreens = new Map<string, boolean>();

  async deviceCloudScreenshots(spaceId: string, deviceId: string) {
    return this.deviceScreens.get(`${spaceId}:${deviceId}`) ?? null;
  }

  async answer(attemptId: string) {
    return this.answers.get(attemptId) ?? null;
  }

  async log(entry: RequestLog) {
    if (this.options.keepLogs !== false) this.logs.push(structuredClone(entry));
  }

  async turns(conversationId: string) {
    return this.logs
      .filter((entry) => entry.scope.conversationId === conversationId && entry.scope.turnId)
      .map((entry) => ({
        turnId: String(entry.scope.turnId),
        route: entry.receipt.route,
        placeholders: entry.receipt.placeholders,
      }));
  }

  async ownsConversation(_spaceId: string, conversationId: string) {
    return [...this.scopes.values()].some((scope) => scope.conversationId === conversationId);
  }

  /** Who each conversation belongs to; unset means nobody. */
  readonly people = new Map<string, string>();

  async conversationPerson(conversationId: string) {
    return this.people.get(conversationId) ?? null;
  }
}

export const newKnownId = () => `pv_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
