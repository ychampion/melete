import { randomUUID } from 'node:crypto';
import type {
  Action,
  ConnectorHealth,
  ConnectorManifest,
  DispatchResult,
  JsonObject,
  VerifyResult,
} from '@melete/contracts';
import { z } from 'zod';
import {
  credentialRefused,
  type EmailConnection,
  ImapSmtpTransport,
  type MailAttachment,
  type MailMessage,
  type MailTransport,
  signInEnded,
  validateMailConnection,
} from './mail-transport.ts';
import type { SecretAccess } from './secrets.ts';
import type { Connector, ConnectorContext } from './types.ts';

const addresses = z
  .union([z.email(), z.array(z.email()).min(1).max(50)])
  .transform((v) => (Array.isArray(v) ? v : [v]));
const outgoing = z
  .object({
    to: addresses,
    cc: addresses.optional(),
    bcc: addresses.optional(),
    subject: z
      .string()
      .max(500)
      .regex(/^[^\r\n]*$/),
    body: z.string().max(200_000),
  })
  .strict();
const search = z
  .object({
    query: z.string().max(1000).default(''),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
const read = z.object({ uid: z.number().int().positive() }).strict();
const readById = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }).strict();
const addressSchema = {
  oneOf: [
    { type: 'string', format: 'email' },
    { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', format: 'email' } },
  ],
};
const outgoingSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['to', 'subject', 'body'],
  properties: {
    to: addressSchema,
    cc: addressSchema,
    bcc: addressSchema,
    subject: { type: 'string', maxLength: 500 },
    body: { type: 'string', maxLength: 200000 },
  },
};

export const emailManifest: ConnectorManifest = {
  name: 'email',
  version: '0.1.0',
  provider: 'imap',
  description: 'Search and read mail, prepare a local draft, or send an approved message.',
  credentials: [
    {
      key: 'app_password',
      description: 'IMAP and SMTP app password, sealed in the service.',
      secret: true,
    },
  ],
  health: true,
  tools: [
    {
      name: 'email.search',
      description: 'Search inbox messages; authentication messages are filtered best-effort.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', maxLength: 1000 },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
      },
      effect_class: 'read',
      required_scopes: ['email.search'],
      verify: false,
      requires_approval: false,
    },
    {
      name: 'email.read',
      description: 'Read an inbox message by UID; authentication messages are withheld.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['uid'],
        properties: { uid: { type: 'integer', minimum: 1 } },
      },
      effect_class: 'read',
      required_scopes: ['email.read'],
      verify: false,
      requires_approval: false,
    },
    {
      name: 'email.draft',
      description: 'Keep a local draft in the action record for review.',
      input_schema: outgoingSchema,
      effect_class: 'write_reversible',
      required_scopes: ['email.draft'],
      verify: false,
      requires_approval: false,
    },
    {
      name: 'email.discard',
      description: 'Discard a local draft this connection prepared.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['draft_id'],
        properties: { draft_id: { type: 'string', minLength: 1, maxLength: 64 } },
      },
      effect_class: 'write_reversible',
      required_scopes: ['email.discard'],
      verify: false,
      requires_approval: false,
    },
    {
      name: 'email.send',
      description: 'Send one approved email with a stable Message-ID; never retry an unknown send.',
      input_schema: outgoingSchema,
      effect_class: 'write_external',
      required_scopes: ['email.send'],
      verify: true,
      requires_approval: true,
    },
  ],
};

/**
 * The same tools over a mailbox that addresses messages by an opaque id, as
 * the Gmail API does: `email.read` takes that id, and search results carry it.
 */
export const idAddressedEmailManifest: ConnectorManifest = {
  ...emailManifest,
  description:
    'Search and read mail, prepare a local draft, or send an approved message, through a signed-in account.',
  credentials: [
    {
      key: 'sign_in',
      description: 'The tokens of an account sign-in, sealed in the service.',
      secret: true,
    },
  ],
  tools: emailManifest.tools.map((tool) =>
    tool.name === 'email.read'
      ? {
          ...tool,
          description: 'Read an inbox message by id; authentication messages are withheld.',
          input_schema: {
            type: 'object',
            additionalProperties: false,
            required: ['id'],
            properties: { id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } },
          },
        }
      : tool,
  ),
};

/**
 * A mailbox reached through an API with a signed-in account rather than a
 * password. `session` hands the work a transport holding that account's access.
 */
export type ApiMailbox = {
  kind: 'api';
  id: string;
  spaceId: string;
  from: string;
  session: <T>(work: (transport: MailTransport) => Promise<T>) => Promise<T>;
};

/** Deliberately best-effort, including decoded body text as well as the subject. */
export function sensitiveInboxMessage(message: MailMessage): boolean {
  const text = `${message.subject}\n${message.text}\n${message.html}`.normalize('NFKC');
  return /\b(?:otp|one[ -]?time (?:pass(?:word|code)|code)|(?:verification|security|authentication|login|sign[ -]?in) code|(?:reset|recover|change)[\s_-]*(?:your[\s_-]*)?password|password[\s_-]*(?:reset|recovery)|magic[\s_-]*link|(?:sign[ -]?in|log[ -]?in) (?:link|to your account))\b/i.test(
    text,
  );
}

export function emailMessageId(actionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(actionId)) throw new Error('Invalid action identity');
  return `<${actionId}@melete.local>`;
}

export class EmailConnector implements Connector {
  readonly manifest: ConnectorManifest;
  private readonly config: { id: string; spaceId: string; from: string };
  private readonly use: <T>(work: (transport: MailTransport) => Promise<T>) => Promise<T>;

  constructor(
    config: EmailConnection | ApiMailbox,
    secrets?: SecretAccess,
    transport: (config: EmailConnection, password: string) => MailTransport = (config, password) =>
      new ImapSmtpTransport(config, password),
  ) {
    this.config = config;
    if ('kind' in config && config.kind === 'api') {
      this.manifest = idAddressedEmailManifest;
      this.use = config.session;
      return;
    }
    const imap = config as EmailConnection;
    validateMailConnection(imap);
    if (!secrets) throw new Error('An IMAP mailbox needs its sealed password');
    this.manifest = emailManifest;
    this.use = (work) =>
      secrets.withSecret(imap.secretRef, imap.spaceId, (password) =>
        work(transport(imap, password)),
      );
  }

  private assertContext(action: Action, ctx: ConnectorContext): void {
    if (
      action.connection_id !== this.config.id ||
      ctx.space_id !== this.config.spaceId ||
      action.job_id !== ctx.job_id ||
      ctx.idempotency_key !== action.id ||
      action.idempotency_key !== action.id
    ) {
      throw new Error('Mail action context mismatch');
    }
    ctx.signal?.throwIfAborted();
  }

  /**
   * The same mailbox, the same credential, the same transport, exposed for the
   * one other thing that sends mail: publishing an artifact as an attachment.
   * It is a separate tool with its own action and its own approval, so this is
   * not a second way to send a message, it is the same way used once more.
   */
  asMailer(): {
    connectionId: string;
    spaceId: string;
    send(
      message: {
        to: string[];
        subject: string;
        body: string;
        messageId: string;
        attachments: MailAttachment[];
      },
      context: { space_id: string; connection_id: string },
    ): Promise<{ messageId: string; accepted?: string[]; rejected?: string[] }>;
  } {
    return {
      connectionId: this.config.id,
      spaceId: this.config.spaceId,
      send: async (message, context) => {
        if (context?.space_id !== this.config.spaceId || context.connection_id !== this.config.id)
          throw new Error('Mail action context mismatch');
        return this.use(async (transport) => {
          const result = await transport.send({
            to: message.to,
            cc: [],
            bcc: [],
            subject: message.subject,
            body: message.body,
            messageId: message.messageId,
            attachments: message.attachments,
          });
          return {
            messageId: result.messageId,
            accepted: result.accepted,
            rejected: result.rejected,
          };
        });
      },
    };
  }

  canSendSignIn(spaceId: string, email: string): boolean {
    return (
      spaceId === this.config.spaceId && this.config.from.toLowerCase() === email.toLowerCase()
    );
  }

  /** Authentication mail is fixed-purpose and cannot be called through the action catalog. */
  async sendSignInLink(spaceId: string, email: string, url: string): Promise<void> {
    if (!this.canSendSignIn(spaceId, email)) throw new Error('Sign-in mailbox mismatch');
    await this.use((transport) =>
      transport.send({
        to: [email],
        cc: [],
        bcc: [],
        subject: 'Melete sign-in link',
        body: `Use this link to sign in to Melete. It expires in ten minutes and can be used once.\n\n${url}\n\nIf you did not request this link, ignore this email.`,
        messageId: `<signin.${randomUUID()}@melete.local>`,
      }),
    );
  }

  private success(
    action: Action,
    detail: JsonObject,
    externalRef: string | null = null,
  ): DispatchResult {
    return {
      outcome: 'succeeded',
      receipt: {
        action_id: action.id,
        connection_id: action.connection_id,
        external_ref: externalRef,
        detail,
        received_at: new Date().toISOString(),
        late: false,
      },
    };
  }

  async execute(action: Action, ctx: ConnectorContext): Promise<DispatchResult> {
    let dispatched = false;
    try {
      this.assertContext(action, ctx);
      // A draft lives only in its action record, so discarding it touches no mailbox.
      if (action.kind === 'email.discard') return this.success(action, { discarded: true });
      if (action.kind === 'email.draft' || action.kind === 'email.send') {
        const payload = outgoing.parse(action.canonical_payload);
        if (action.kind === 'email.draft') return this.success(action, { draft: payload });
        const messageId = emailMessageId(action.id);
        return await this.use(async (transport) => {
          ctx.signal?.throwIfAborted();
          dispatched = true;
          const result = await transport.send({
            ...payload,
            cc: payload.cc ?? [],
            bcc: payload.bcc ?? [],
            messageId,
          });
          return this.success(
            action,
            {
              message_id: messageId,
              sent_copy: result.sentCopy,
              accepted: result.accepted ?? null,
              rejected: result.rejected ?? null,
            },
            messageId,
          );
        });
      }
      if (action.kind === 'email.search') {
        const payload = search.parse(action.canonical_payload);
        const messages = await this.use((transport) =>
          transport.search(payload.query, payload.limit),
        );
        return this.success(action, {
          messages: messages
            .filter((message) => !sensitiveInboxMessage(message))
            .map(({ html: _html, ...message }) => message),
        });
      }
      if (action.kind === 'email.read') {
        const key =
          this.manifest === idAddressedEmailManifest
            ? readById.parse(action.canonical_payload).id
            : read.parse(action.canonical_payload).uid;
        const message = await this.use((transport) => transport.read(key));
        if (!message || sensitiveInboxMessage(message))
          return {
            outcome: 'failed',
            reason: 'Message unavailable or withheld by inbox hygiene.',
            retryable: false,
          };
        const { html: _html, ...safe } = message;
        return this.success(action, { message: safe });
      }
      return { outcome: 'failed', reason: 'Unknown email tool.', retryable: false };
    } catch {
      return dispatched
        ? {
            outcome: 'unknown',
            reason: 'Mail dispatch was not acknowledged. Verify the Sent folder before deciding.',
          }
        : {
            outcome: 'failed',
            reason: 'Mail request rejected or connection unavailable.',
            retryable: false,
          };
    }
  }

  async verify(action: Action, ctx: ConnectorContext): Promise<VerifyResult> {
    if (action.kind !== 'email.send')
      return { decision: 'unsupported', reason: 'Only sent email has external verification.' };
    try {
      this.assertContext(action, ctx);
      const messageId = emailMessageId(action.id);
      const found = await this.use((transport) => transport.findSent(messageId));
      if (!found)
        return {
          decision: 'undecided',
          reason:
            'Message-ID is absent from Sent; absence does not prove the message was not delivered.',
        };
      const result = this.success(
        action,
        { message_id: messageId, verified_in: 'Sent' },
        messageId,
      );
      return {
        decision: 'succeeded',
        evidence: { message_id: messageId },
        receipt: result.outcome === 'succeeded' ? result.receipt : null,
      };
    } catch {
      return { decision: 'undecided', reason: 'Sent-folder verification is unavailable.' };
    }
  }

  async health(): Promise<ConnectorHealth> {
    try {
      await this.use((transport) => transport.health());
      return {
        status: 'ok',
        detail: 'The mailbox is available.',
        checked_at: new Date().toISOString(),
      };
    } catch (error) {
      return {
        status: 'failing',
        detail: 'Mail connection unavailable.',
        checked_at: new Date().toISOString(),
        ...(signInEnded(error)
          ? { reason: 'sign_in_required' as const }
          : credentialRefused(error)
            ? { reason: 'credential_refused' as const }
            : {}),
      };
    }
  }
}
