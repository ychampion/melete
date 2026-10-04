/**
 * The built-in `notes` connection: the agent's own working notes. One tool,
 * `notes.write`, keeps something the agent learned for itself in this chat so
 * it has it in the next ("the clinic's online form rejects .heic photos").
 *
 * A note is the agent's, never the person's statement: it comes back to the
 * agent labelled as its own note, at inferred trust, and the person sees and
 * deletes it in Memory. It stays in the person's own space and reaches nobody,
 * so writing one asks no one. Only a person's own work writes notes, and only
 * in their personal space; a note from a private conversation is marked so,
 * and is read back only on the person's own model.
 */
import type { Action, ConnectorManifest, JsonValue, Receipt } from '@melete/contracts';
import type { Sql } from 'postgres';
import { BrokerFault } from '../broker/errors.ts';
import { stableEntityId } from '../memory/db.ts';
import { NOTE_LIMIT, writeNote } from '../memory/notes.ts';
import type { Connector, ConnectorContext } from './types.ts';

export const NOTES_PROVIDER = 'notes';

export const notesManifest: ConnectorManifest = {
  name: 'notes',
  version: '0.1.0',
  provider: NOTES_PROVIDER,
  description: 'Keep a short note for yourself that you will want in later chats with this person.',
  credentials: [],
  health: true,
  tools: [
    {
      name: 'notes.write',
      description:
        "Keep a note for yourself: something you found out or worked out here that will help in a later chat (how a site behaves, what failed, where something is). It is your note, not the person's words: never record their preferences or facts about them as if they said them. You get relevant notes back later, labelled as yours; the person can read and delete them in Memory.",
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string', minLength: 1, maxLength: NOTE_LIMIT } },
      },
      effect_class: 'write_reversible',
      required_scopes: ['notes.write'],
      verify: false,
      requires_approval: false,
    },
  ],
};

export type NotesConnectorOptions = {
  sql: Sql;
  /**
   * Why what is written in this job is private, as memory records it on what
   * it learns: a private space or agent, or a sensitive conversation. Left
   * out, notes are marked as written in a private conversation, so they are
   * only read back on the person's own model.
   */
  privacyOrigin?: (jobId: string, text: string) => Promise<string | null>;
};

export function createNotesConnector(options: NotesConnectorOptions): Connector {
  const receiptFor = (
    action: Action,
    detail: Record<string, JsonValue>,
    externalRef: string | null,
  ): Receipt => ({
    action_id: action.id,
    connection_id: action.connection_id,
    external_ref: externalRef,
    detail,
    received_at: new Date().toISOString(),
    late: false,
  });

  /** The person whose own work this is, in the space the action runs in. */
  const ownWork = async (ctx: ConnectorContext) => {
    const [row] = await options.sql`select j.audience, j.space_id,
        coalesce(j.principal_id, (select id from owner limit 1)) as principal_id
      from job j where j.id = ${ctx.job_id}`;
    if (!row || row.space_id !== ctx.space_id || row.audience !== 'principal' || !row.principal_id)
      throw new BrokerFault('scope_denied', "Only a person's own work keeps notes.");
    if (ctx.constraints.public_compartment)
      throw new BrokerFault('scope_denied', 'Notes are not kept for a public conversation.');
    return { principalId: String(row.principal_id) };
  };

  const textOf = (action: Action) => {
    const text = action.canonical_payload.text;
    if (typeof text !== 'string' || !text.trim() || text.length > NOTE_LIMIT)
      throw new BrokerFault('payload_invalid', 'A note is between 1 and 2000 characters.');
    return text.trim();
  };

  return {
    manifest: notesManifest,
    // It stays in the person's own space, where they read and delete it.
    staysInSpace: () => true,
    async execute(action, ctx) {
      if (action.job_id !== ctx.job_id || action.id !== ctx.idempotency_key)
        throw new Error('connector action identity mismatch');
      ctx.signal?.throwIfAborted();
      if (action.kind !== 'notes.write') throw new Error('unknown notes tool');
      const text = textOf(action);
      const { principalId } = await ownWork(ctx);
      const privateOrigin = options.privacyOrigin
        ? await options.privacyOrigin(ctx.job_id, text)
        : 'unknown';
      const note = await writeNote(options.sql, {
        spaceId: ctx.space_id,
        principalId,
        jobId: ctx.job_id,
        content: text,
        privateOrigin,
        // A dispatch tried again keeps the same note, not a second one.
        idempotencyKey: action.id,
      });
      return {
        outcome: 'succeeded',
        receipt: receiptFor(
          action,
          {
            note_id: note.id,
            kept: true,
            note: 'Kept as your own note. It comes back in later chats when relevant, labelled as yours; the person can delete it in Memory.',
          },
          note.id,
        ),
      };
    },
    async verify(action) {
      const [row] = await options.sql`select id from memory_agent_notes
        where id = ${stableEntityId('note', 'agent-note', action.id)}`;
      return row
        ? {
            decision: 'succeeded',
            evidence: { note_id: String(row.id) },
            receipt: receiptFor(action, { note_id: String(row.id), kept: true }, String(row.id)),
          }
        : { decision: 'undecided', reason: 'no note was kept for this action' };
    },
    async health() {
      return { status: 'ok', detail: 'notes are available', checked_at: new Date().toISOString() };
    },
  };
}
