/**
 * The privacy router's surface: what the person tunes in Settings → Privacy,
 * what the preview shows, and what each answer says it protected.
 *
 * Values never travel in these shapes except in the reveal, which the person's
 * own interface asks for and draws locally; everything else carries counts,
 * categories and placeholder names.
 */
import { z } from 'zod';

/** The kinds of detail the router swaps for a placeholder. */
export const PRIVACY_CATEGORIES = [
  'account',
  'card',
  'routing',
  'ssn',
  'tax_id',
  'national_id',
  'passport',
  'license',
  'health',
  'address',
  'phone',
  'email',
  'dob',
  'credential',
  'name',
  'private',
] as const;
export const privacyCategory = z.enum(PRIVACY_CATEGORIES).meta({ id: 'PrivacyCategory' });
export type PrivacyCategory = z.infer<typeof privacyCategory>;

/** The word inside a placeholder: ⟦ACCOUNT_1⟧. */
export const PRIVACY_PLACEHOLDER_LABELS: Record<PrivacyCategory, string> = {
  account: 'ACCOUNT',
  card: 'CARD',
  routing: 'ROUTING',
  ssn: 'SSN',
  tax_id: 'TAX_ID',
  national_id: 'NATIONAL_ID',
  passport: 'PASSPORT',
  license: 'LICENSE',
  health: 'HEALTH',
  address: 'ADDRESS',
  phone: 'PHONE',
  email: 'EMAIL',
  dob: 'DOB',
  credential: 'CREDENTIAL',
  name: 'NAME',
  private: 'PRIVATE',
};

/** Plain-language names for the settings screen and the reveal. */
export const PRIVACY_CATEGORY_NAMES: Record<PrivacyCategory, string> = {
  account: 'Bank and account numbers',
  card: 'Card numbers',
  routing: 'Routing and sort codes',
  ssn: 'Social Security numbers',
  tax_id: 'Tax IDs',
  national_id: 'National ID numbers',
  passport: 'Passport numbers',
  license: 'Driving licence numbers',
  health: 'Health details',
  address: 'Street addresses',
  phone: 'Phone numbers',
  email: 'Email addresses',
  dob: 'Dates of birth',
  credential: 'Passwords and keys',
  name: 'Names you mark private',
  private: 'Other things you mark private',
};

/** Topics that make a whole conversation private rather than redacted. */
export const SENSITIVE_TOPICS = ['health', 'therapy', 'finance'] as const;
export const sensitiveTopic = z.enum(SENSITIVE_TOPICS).meta({ id: 'SensitiveTopic' });
export type SensitiveTopic = z.infer<typeof sensitiveTopic>;

const id = () => z.string().min(1).max(240);
const label = () => z.string().trim().min(1).max(80);

/** A value the person asked to protect, shown back only by a short hint. */
export const privacyKnownValue = z.strictObject({
  id: id(),
  label: label(),
  category: privacyCategory,
  hint: z.string().max(12),
});
export type PrivacyKnownValue = z.infer<typeof privacyKnownValue>;

/** The person's own model server, reached over the OpenAI-compatible API. */
export const localModelView = z.strictObject({
  base_url: z.string().url().max(500),
  model: z.string().min(1).max(200),
  has_key: z.boolean(),
});

export const privacySettings = z.strictObject({
  /** Categories swapped out before a request leaves for a cloud model. */
  enabled: z.array(privacyCategory),
  /** Topics that keep a conversation on the local model, or ask first. */
  sensitive_topics: z.array(sensitiveTopic),
  /** Everything in this space stays on the local model. */
  private_space: z.boolean(),
  /** Agents whose conversations stay on the local model. */
  private_agent_ids: z.array(id()).max(200),
  local_model: localModelView.nullable(),
  /** Ask the local model to find names, addresses and health details too. */
  local_detection: z.boolean(),
  known_values: z.array(privacyKnownValue).max(200),
  /** The configured model's address is on this machine or the person's network. */
  model_address_local: z.boolean(),
  /** That address, shown so the owner can tell what they would confirm; null when it is not local. */
  model_address: z.string().max(500).nullable(),
  /**
   * The owner confirmed that address is a model running on a machine they
   * control, not a proxy to a cloud service, so requests to it are sent as
   * written. An address on their network alone is never taken as this.
   */
  model_on_device: z.boolean(),
  /** Whether swapped details are kept, sealed, between requests. */
  sealed_vault: z.boolean(),
  /**
   * Cloud models may see screenshots of the agent's own computer and browser
   * in an ordinary conversation. Pictures are not redacted.
   */
  screenshots_own_computer: z.boolean(),
  /**
   * Cloud models may see screenshots of paired computers in an ordinary
   * conversation. A computer's own setting, when it has one, wins.
   */
  screenshots_paired_devices: z.boolean(),
});
export type PrivacySettings = z.infer<typeof privacySettings>;

export const privacySettingsUpdate = z.strictObject({
  enabled: z.array(privacyCategory).optional(),
  sensitive_topics: z.array(sensitiveTopic).optional(),
  private_space: z.boolean().optional(),
  private_agent_ids: z.array(id()).max(200).optional(),
  local_model: z
    .strictObject({
      base_url: z.string().url().max(500),
      model: z.string().trim().min(1).max(200),
      /** Absent keeps the saved key, null removes it. */
      api_key: z.string().min(1).max(500).nullable().optional(),
    })
    .nullable()
    .optional(),
  local_detection: z.boolean().optional(),
  screenshots_own_computer: z.boolean().optional(),
  screenshots_paired_devices: z.boolean().optional(),
  /** Confirm (true) or withdraw (false) that the configured model's address is a model the owner runs. */
  model_on_device: z.boolean().optional(),
  add_known_values: z
    .array(
      z.strictObject({
        label: label(),
        category: privacyCategory,
        value: z.string().trim().min(2).max(200),
      }),
    )
    .max(50)
    .optional(),
  remove_known_values: z.array(id()).max(200).optional(),
});
export type PrivacySettingsUpdate = z.infer<typeof privacySettingsUpdate>;

/** Where a request goes. `on_device` is a configured model the owner confirmed they run. */
export const privacyRoute = z
  .enum(['cloud', 'local', 'ask', 'on_device'])
  .meta({ id: 'PrivacyRoute' });
export type PrivacyRoute = z.infer<typeof privacyRoute>;

export const privacyPreviewRequest = z.strictObject({
  text: z.string().min(1).max(20_000),
  agent_id: id().optional(),
});
export const privacyPreview = z.strictObject({
  /** Exactly what a cloud model would be sent for this text. */
  sent: z.string(),
  route: privacyRoute,
  sensitive: sensitiveTopic.nullable(),
  details: z.array(
    z.strictObject({
      placeholder: z.string(),
      category: privacyCategory,
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
    }),
  ),
});
export type PrivacyPreview = z.infer<typeof privacyPreview>;

export const localModelCheckRequest = z.strictObject({
  base_url: z.string().url().max(500).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  api_key: z.string().min(1).max(500).optional(),
});
export const localModelCheck = z.strictObject({
  ok: z.boolean(),
  message: z.string().min(1).max(500),
  models: z.array(z.string().max(200)).max(100),
});
export type LocalModelCheck = z.infer<typeof localModelCheck>;

const categoryCount = z.strictObject({
  category: privacyCategory,
  count: z.number().int().nonnegative(),
});

export const conversationPrivacy = z.strictObject({
  sensitive: sensitiveTopic.nullable(),
  turns: z.array(
    z.strictObject({
      turn_id: id(),
      protected: z.number().int().nonnegative(),
      categories: z.array(categoryCount),
      route: z.enum(['cloud', 'local', 'mixed', 'on_device']),
    }),
  ),
});
export type ConversationPrivacy = z.infer<typeof conversationPrivacy>;

/** The person's own word on a conversation: a topic marks it sensitive, null clears a wrong verdict. */
export const conversationPrivacyUpdate = z.strictObject({ sensitive: sensitiveTopic.nullable() });
export type ConversationPrivacyUpdate = z.infer<typeof conversationPrivacyUpdate>;

export const privacyRevealRequest = z.strictObject({ turn_id: id() });
export const privacyReveal = z.strictObject({
  items: z.array(
    z.strictObject({ placeholder: z.string(), category: privacyCategory, value: z.string() }),
  ),
});
export type PrivacyReveal = z.infer<typeof privacyReveal>;

/** What a model receipt records about one request: never a value. */
export const privacyReceipt = z.object({
  route: privacyRoute,
  protected: z.number().int().nonnegative(),
  categories: z.record(z.string(), z.number().int().nonnegative()),
  placeholders: z.array(z.string()),
  local_detection: z.enum(['off', 'used', 'failed']).optional(),
});
export type PrivacyReceipt = z.infer<typeof privacyReceipt>;

/** The operations the interface calls, served beside the experience surface. */
export const privacyOperations = {
  'GET /privacy/settings': { response: privacySettings },
  'PUT /privacy/settings': { request: privacySettingsUpdate, response: privacySettings },
  'POST /privacy/preview': { request: privacyPreviewRequest, response: privacyPreview },
  'POST /privacy/local-model/check': { request: localModelCheckRequest, response: localModelCheck },
  'GET /conversations/{id}/privacy': { response: conversationPrivacy },
  'PUT /conversations/{id}/privacy': {
    request: conversationPrivacyUpdate,
    response: conversationPrivacy,
  },
  'POST /conversations/{id}/privacy/reveal': {
    request: privacyRevealRequest,
    response: privacyReveal,
  },
} satisfies Record<string, { request?: z.ZodType; response: z.ZodType }>;
