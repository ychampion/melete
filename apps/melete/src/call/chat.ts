/**
 * The conversation a call speaks into, through the same service the chat's own
 * routes use. What the person says is a message, sent the way a typed one is,
 * so memory, rules, approvals and the tool rows work exactly as in chat.
 */
import type { QuickCommand } from '@melete/contracts';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import type { CompanionContext, VoiceCompanion } from '../api/voice-companion.ts';
import type { ExperienceService } from '../experience/service.ts';
import { principalContext } from '../principals/authority.ts';
import type { CallAside, CallChat, CallTurn, CallWaiting } from './session.ts';

export type CallScope = {
  spaceId: string;
  principalId: string;
  conversationId: string;
  agentId: string | null;
};

const UNDER_WAY = ['queued', 'working', 'streaming', 'stalled', 'paused'];

/** What the person hears when the chat could not take what they said. */
const NOT_TAKEN = 'I couldn’t take that just now. Try again in a moment.';

export function experienceCallChat(deps: {
  sql: Sql;
  experience: ExperienceService;
  scope: CallScope;
  /** Waits from before the call are not the call's to announce. */
  since: Date;
  companion?: VoiceCompanion | null;
  context?: (conversationId: string, agentId: string | null) => Promise<CompanionContext>;
}): CallChat {
  const { sql, experience, scope, since } = deps;
  const { spaceId, principalId, conversationId } = scope;
  const asPerson = <T>(work: () => Promise<T>) => principalContext.run(principalId, work);

  const chat: CallChat = {
    async say(text) {
      try {
        const taken = await asPerson(() =>
          experience.message(spaceId, conversationId, { text: text.slice(0, 20_000) }),
        );
        return 'turn_id' in taken ? { turnId: taken.turn_id } : { refused: NOT_TAKEN };
      } catch (error) {
        if (error instanceof ServiceError) return { refused: NOT_TAKEN };
        throw error;
      }
    },
    async running() {
      const [row] = await sql<{ id: string }[]>`select t.id from job j
        join experience_turn t on t.id = j.current_turn_id and t.job_id = j.id
        where j.id = ${conversationId} and t.status in ${sql(UNDER_WAY)}`;
      return row?.id ?? null;
    },
    async turn(turnId) {
      const [row] = await sql<CallTurn[]>`select status, answer from experience_turn
        where id = ${turnId} and job_id = ${conversationId}`;
      return row ?? null;
    },
    async waiting(): Promise<CallWaiting | null> {
      const [asked] = await sql<{ id: string; text: string }[]>`select q.id, q.text from question q
        join job j on j.id = q.job_id
        where (j.id = ${conversationId} or j.experience_parent_id = ${conversationId})
          and q.state = 'open' and q.created_at >= ${since.toISOString()}
        order by q.created_at limit 1`;
      if (asked) return { kind: 'question', key: asked.id, text: asked.text };
      const [approval] = await sql<{ id: string }[]>`select a.id from approval a
        join action ac on ac.id = a.action_id
        join job j on j.id = ac.job_id
        where (j.id = ${conversationId} or j.experience_parent_id = ${conversationId})
          and a.decided_at is null and a.requested_at >= ${since.toISOString()}
          and (a.expires_at is null or a.expires_at > now())
        order by a.requested_at limit 1`;
      return approval ? { kind: 'approval', key: approval.id } : null;
    },
    async control(command: QuickCommand) {
      await asPerson(async () => {
        if (command === 'stop') await experience.stop(spaceId, conversationId);
        else await experience.pause(spaceId, conversationId, command === 'resume');
      });
    },
  };
  const companion = deps.companion;
  const context = deps.context;
  if (companion && context)
    chat.aside = async (text): Promise<CallAside | null> => {
      const known = await context(conversationId, scope.agentId);
      const result = await companion.answer({
        spaceId,
        conversationId,
        principalId,
        request: { kind: 'heard', text: text.slice(0, 1000), activity: { now: null, steps: [] } },
        context: known,
      });
      return 'answer' in result ? result.answer : null;
    };
  return chat;
}
