/**
 * Fold a conversation's saved turns and its events into the transcript the
 * screen draws. The same reducer runs over the replayed history and over the
 * live stream, so a reload and a reconnect produce the same picture. A gap is
 * kept on the transcript: text that streamed while the connection was down
 * is gone, and the interface says so rather than stitching halves.
 */
import type { StreamGap } from './adapter.ts';
import type {
  ComposerState,
  Draft,
  ExperienceEvent,
  Permission,
  PermissionOption,
  Question,
  Receipt,
  ResultCard,
  TrailStep,
  Turn,
  TurnStatus,
} from './types.ts';

export type TurnBlock =
  | { type: 'card'; card: ResultCard }
  | { type: 'receipt'; receipt: Receipt; reversed: boolean }
  /**
   * `decided` is the option this client chose; `closed` means the turn moved on
   * after a decision made elsewhere (the contract carries no decision event).
   */
  | { type: 'permission'; permission: Permission; decided: PermissionOption | 'closed' | null }
  /** `answered` is the option id, or `closed` when the turn moved on after an answer given elsewhere. */
  | { type: 'question'; question: Question; answered: string | null };

export type TranscriptTurn = {
  id: string;
  /** The person's message and the agent's saved answer, as the service holds them. */
  turn: Turn;
  /** Text streamed since the saved answer was read. */
  streamed: string;
  status: TurnStatus;
  trail: TrailStep[];
  blocks: TurnBlock[];
  /** True while text_delta items are arriving for this turn. */
  streaming: boolean;
  delivery: Turn['delivery'];
};

export type Transcript = {
  turns: TranscriptTurn[];
  gaps: StreamGap[];
  lastSeq: number;
  composer: ComposerState;
  status: TurnStatus;
  /** Drafts this conversation holds, keyed by id, refreshed after a send. */
  drafts: Record<string, Draft>;
};

export const emptyTranscript = (): Transcript => ({
  turns: [],
  gaps: [],
  lastSeq: 0,
  composer: 'send',
  status: 'idle',
  drafts: {},
});

const fromTurn = (turn: Turn): TranscriptTurn => ({
  id: turn.id,
  turn,
  streamed: '',
  status: turn.status,
  trail: [],
  blocks: [],
  streaming: false,
  delivery: turn.delivery,
});

export function fromTurns(turns: Turn[], composer: ComposerState, status: TurnStatus): Transcript {
  return { ...emptyTranscript(), turns: turns.map(fromTurn), composer, status };
}

function patchTurn(
  transcript: Transcript,
  turnId: string | null,
  patch: (turn: TranscriptTurn) => TranscriptTurn,
): Transcript {
  const index = turnId
    ? transcript.turns.findIndex((t) => t.id === turnId)
    : transcript.turns.length - 1;
  if (index < 0) return transcript;
  const turns = transcript.turns.slice();
  const current = turns[index];
  if (!current) return transcript;
  turns[index] = patch(current);
  return { ...transcript, turns };
}

/** The saved answer plus what streamed after it was read, never doubled. */
export const answerOf = (turn: TranscriptTurn): string =>
  turn.streamed && turn.turn.answer.endsWith(turn.streamed)
    ? turn.turn.answer
    : turn.turn.answer + turn.streamed;

/** A card, receipt, permission or question already drawn is not drawn twice. */
const blockId = (block: TurnBlock): string =>
  block.type === 'card'
    ? block.card.id
    : block.type === 'receipt'
      ? block.receipt.id
      : block.type === 'permission'
        ? block.permission.id
        : block.question.id;

const hasBlock = (transcript: Transcript, id: string): boolean =>
  transcript.turns.some((turn) => turn.blocks.some((block) => blockId(block) === id));

export function applyEvent(transcript: Transcript, event: ExperienceEvent): Transcript {
  const lastSeq = Math.max(transcript.lastSeq, event.seq);
  const item = event.item;
  const base = { ...transcript, lastSeq };
  if (
    (item.type === 'card' && hasBlock(base, item.card.id)) ||
    (item.type === 'receipt' && hasBlock(base, item.receipt.id)) ||
    (item.type === 'permission' && hasBlock(base, item.permission.id)) ||
    (item.type === 'question' && hasBlock(base, item.question.id))
  )
    return base;
  switch (item.type) {
    case 'say':
    case 'action':
    case 'note':
    case 'done':
      return patchTurn(base, event.turn_id, (turn) => ({
        ...turn,
        trail: [...turn.trail, item],
        streaming: item.type === 'done' ? false : turn.streaming,
      }));
    case 'text_delta':
      return patchTurn(base, event.turn_id, (turn) => ({
        ...turn,
        streamed: turn.streamed + item.text,
        streaming: true,
      }));
    case 'card':
      return patchTurn(base, event.turn_id, (turn) => ({
        ...turn,
        blocks: [...turn.blocks, { type: 'card', card: item.card }],
      }));
    case 'receipt': {
      // A reversal names the change it undid; the original is drawn as reversed.
      const reversal = item.receipt.what.startsWith('Removed again');
      return patchTurn(base, event.turn_id, (turn) => ({
        ...turn,
        blocks: [
          ...turn.blocks.map((block) =>
            reversal && block.type === 'receipt' && block.receipt.undo
              ? { ...block, reversed: true }
              : block,
          ),
          { type: 'receipt', receipt: item.receipt, reversed: false },
        ],
      }));
    }
    case 'permission':
      return patchTurn(base, event.turn_id, (turn) => ({
        ...turn,
        blocks: [
          ...turn.blocks,
          { type: 'permission', permission: item.permission, decided: null },
        ],
      }));
    case 'question':
      return patchTurn(base, event.turn_id, (turn) => ({
        ...turn,
        blocks: [...turn.blocks, { type: 'question', question: item.question, answered: null }],
      }));
    case 'status': {
      const next = { ...base, composer: item.composer, status: item.status };
      const movedOn = !['needs_you', 'paused', 'queued', 'idle'].includes(item.status);
      return patchTurn(next, event.turn_id, (turn) => ({
        ...turn,
        status: item.status,
        streaming: item.status === 'streaming' ? turn.streaming : false,
        turn: { ...turn.turn, status: item.status },
        blocks: movedOn
          ? turn.blocks.map((block) =>
              block.type === 'permission' && block.decided === null
                ? { ...block, decided: 'closed' }
                : block.type === 'question' && block.answered === null
                  ? { ...block, answered: 'closed' }
                  : block,
            )
          : turn.blocks,
      }));
    }
    default:
      return base;
  }
}

export function applyEvents(transcript: Transcript, events: ExperienceEvent[]): Transcript {
  return events.reduce(applyEvent, transcript);
}

export function applyGap(transcript: Transcript, gap: StreamGap): Transcript {
  const known = transcript.gaps.some((g) => g.after === gap.after && g.reason === gap.reason);
  return known ? transcript : { ...transcript, gaps: [...transcript.gaps, gap] };
}

/** A message the person just sent, drawn before the service confirms it. */
export function addLocalTurn(
  transcript: Transcript,
  text: string,
  agentId: string,
  conversationId: string,
  delivery: Turn['delivery'],
  id = `local_${Date.now()}`,
): Transcript {
  const turn: Turn = {
    id,
    conversation_id: conversationId,
    agent_id: agentId,
    text,
    answer: '',
    status: 'queued',
    delivery,
    created_at: new Date().toISOString(),
  };
  return { ...transcript, turns: [...transcript.turns, fromTurn(turn)] };
}

/** The service accepted the message: adopt its turn id and clear the delivery flag. */
export function acceptLocalTurn(
  transcript: Transcript,
  localId: string,
  turnId: string,
): Transcript {
  return {
    ...transcript,
    turns: transcript.turns.map((t) =>
      t.id === localId
        ? { ...t, id: turnId, delivery: null, turn: { ...t.turn, id: turnId, delivery: null } }
        : t,
    ),
  };
}

export function setDelivery(
  transcript: Transcript,
  localId: string,
  delivery: Turn['delivery'],
): Transcript {
  return {
    ...transcript,
    turns: transcript.turns.map((t) =>
      t.id === localId ? { ...t, delivery, turn: { ...t.turn, delivery } } : t,
    ),
  };
}

export function markPermission(
  transcript: Transcript,
  id: string,
  option: PermissionOption,
): Transcript {
  return {
    ...transcript,
    turns: transcript.turns.map((turn) => ({
      ...turn,
      blocks: turn.blocks.map((block) =>
        block.type === 'permission' && block.permission.id === id
          ? { ...block, decided: option }
          : block,
      ),
    })),
  };
}

export function markQuestion(transcript: Transcript, id: string, optionId: string): Transcript {
  return {
    ...transcript,
    turns: transcript.turns.map((turn) => ({
      ...turn,
      blocks: turn.blocks.map((block) =>
        block.type === 'question' && block.question.id === id
          ? { ...block, answered: optionId }
          : block,
      ),
    })),
  };
}

export function setDrafts(transcript: Transcript, drafts: Draft[]): Transcript {
  const next = { ...transcript.drafts };
  for (const draft of drafts) next[draft.id] = draft;
  return { ...transcript, drafts: next };
}

export function latestTurn(transcript: Transcript): TranscriptTurn | null {
  return transcript.turns[transcript.turns.length - 1] ?? null;
}

/** The newest unanswered question in the newest turn is the one the number keys answer. */
export function openQuestion(transcript: Transcript): Question | null {
  const last = latestTurn(transcript);
  if (!last) return null;
  for (let i = last.blocks.length - 1; i >= 0; i -= 1) {
    const block = last.blocks[i];
    if (block?.type === 'question' && !block.answered) return block.question;
  }
  return null;
}
