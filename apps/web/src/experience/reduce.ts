/**
 * Fold a conversation's events into the transcript the screen draws. The
 * same reducer runs over the replayed history and over the live stream, so a
 * reload and a reconnect produce the same picture. A gap is kept as a
 * transcript item: text that streamed while the connection was down is gone,
 * and the interface says so instead of stitching the halves together.
 */
import type {
  Block,
  ConversationEvent,
  Message,
  StreamGap,
  TrailStep,
  Turn,
  TurnStatus,
  UserMessage,
} from './types.ts';

export type TranscriptItem = Message | { role: 'gap'; id: string; gap: StreamGap };

export type Transcript = {
  items: TranscriptItem[];
  lastSeq: number;
};

export const emptyTranscript = (): Transcript => ({ items: [], lastSeq: 0 });

const isTurn = (item: TranscriptItem): item is Turn => item.role === 'assistant';

function patchTurn(
  items: TranscriptItem[],
  turnId: string,
  patch: (turn: Turn) => Turn,
): TranscriptItem[] {
  let found = false;
  const next = items.map((item) => {
    if (isTurn(item) && item.id === turnId) {
      found = true;
      return patch(item);
    }
    return item;
  });
  return found ? next : items;
}

function patchBlock(blocks: Block[], blockId: string, patch: Record<string, unknown>): Block[] {
  return blocks.map((block) => {
    switch (block.kind) {
      case 'card':
        return block.card.id === blockId ? { ...block, card: { ...block.card, ...patch } } : block;
      case 'receipt':
        return block.receipt.id === blockId
          ? { ...block, receipt: { ...block.receipt, ...patch } }
          : block;
      case 'draft':
        return block.draft.id === blockId
          ? { ...block, draft: { ...block.draft, ...patch } }
          : block;
      case 'permission':
        return block.permission.id === blockId
          ? { ...block, permission: { ...block.permission, ...patch } }
          : block;
      case 'question':
        return block.question.id === blockId
          ? { ...block, question: { ...block.question, ...patch } }
          : block;
      case 'unknown':
        return block.unknown.id === blockId
          ? { ...block, unknown: { ...block.unknown, ...patch } }
          : block;
      case 'browser':
        return block.browser.id === blockId
          ? { ...block, browser: { ...block.browser, ...patch } }
          : block;
      default:
        return block;
    }
  });
}

export function applyEvent(transcript: Transcript, event: ConversationEvent): Transcript {
  const p = event.payload;
  const lastSeq = Math.max(transcript.lastSeq, event.seq);
  const turnId = typeof p.turn_id === 'string' ? p.turn_id : '';

  switch (event.type) {
    case 'user_message': {
      const message: UserMessage = {
        id: String(p.id ?? `u_${event.seq}`),
        role: 'user',
        text: String(p.text ?? ''),
        at: String(p.at ?? event.created_at),
        delivery: 'sent',
        attachments: Array.isArray(p.attachments)
          ? (p.attachments as UserMessage['attachments'])
          : [],
      };
      // A message the composer already drew optimistically is replaced, not doubled.
      const items = transcript.items.filter(
        (item) => !(item.role === 'user' && item.delivery !== 'sent' && item.text === message.text),
      );
      return { items: [...items, message], lastSeq };
    }
    case 'turn_started': {
      const turn: Turn = {
        id: turnId,
        role: 'assistant',
        agent_id: typeof p.agent_id === 'string' ? p.agent_id : null,
        status: 'queued',
        text: '',
        text_streaming: false,
        trail: [],
        started_at: String(p.at ?? event.created_at),
        ended_at: null,
        blocks: [],
        reaction: null,
        at: String(p.at ?? event.created_at),
      };
      return { items: [...transcript.items, turn], lastSeq };
    }
    case 'turn_status': {
      const status = String(p.status) as TurnStatus | 'waiting';
      return {
        items: patchTurn(transcript.items, turnId, (turn) => ({
          ...turn,
          status: status === 'waiting' ? 'waiting' : status,
          text_streaming: status === 'streaming',
          ended_at: typeof p.ended_at === 'string' ? p.ended_at : turn.ended_at,
        })),
        lastSeq,
      };
    }
    case 'trail_step': {
      const step = p.step as TrailStep;
      return {
        items: patchTurn(transcript.items, turnId, (turn) => ({
          ...turn,
          trail: [...turn.trail, step],
        })),
        lastSeq,
      };
    }
    case 'trail_step_updated': {
      const patch = (p.patch ?? {}) as Partial<TrailStep>;
      return {
        items: patchTurn(transcript.items, turnId, (turn) => ({
          ...turn,
          trail: turn.trail.map((step) =>
            step.id === p.step_id ? ({ ...step, ...patch } as TrailStep) : step,
          ),
        })),
        lastSeq,
      };
    }
    case 'text_delta': {
      const delta = String(p.text ?? '');
      return {
        items: patchTurn(transcript.items, turnId, (turn) => ({
          ...turn,
          text: turn.text + delta,
          text_streaming: true,
        })),
        lastSeq: transcript.lastSeq,
      };
    }
    case 'text_final': {
      const text = String(p.text ?? '');
      return {
        items: patchTurn(transcript.items, turnId, (turn) => ({
          ...turn,
          text: text || turn.text,
          text_streaming: false,
        })),
        lastSeq,
      };
    }
    case 'block': {
      const block = p.block as Block;
      return {
        items: patchTurn(transcript.items, turnId, (turn) => ({
          ...turn,
          blocks: [...turn.blocks, block],
        })),
        lastSeq,
      };
    }
    case 'block_updated': {
      const patch = (p.patch ?? {}) as Record<string, unknown>;
      return {
        items: patchTurn(transcript.items, turnId, (turn) => ({
          ...turn,
          blocks: patchBlock(turn.blocks, String(p.block_id), patch),
        })),
        lastSeq,
      };
    }
    case 'reaction': {
      return {
        items: patchTurn(transcript.items, turnId, (turn) => ({
          ...turn,
          reaction: (p.reaction as Turn['reaction']) ?? null,
        })),
        lastSeq,
      };
    }
    default:
      return { ...transcript, lastSeq };
  }
}

export function applyGap(transcript: Transcript, gap: StreamGap): Transcript {
  const known = transcript.items.some(
    (item) => item.role === 'gap' && item.gap.after === gap.after && item.gap.reason === gap.reason,
  );
  if (known) return transcript;
  return {
    ...transcript,
    items: [...transcript.items, { role: 'gap', id: `gap_${gap.after}`, gap }],
  };
}

export function reduceAll(events: ConversationEvent[]): Transcript {
  return events.reduce(applyEvent, emptyTranscript());
}

/** The last assistant turn, which is what the composer's state button follows. */
export function latestTurn(transcript: Transcript): Turn | null {
  for (let i = transcript.items.length - 1; i >= 0; i -= 1) {
    const item = transcript.items[i];
    if (item && isTurn(item)) return item;
  }
  return null;
}

/** Card buttons that decide a permission make the separate permission card redundant. */
export function claimedPermissions(turn: Turn): Set<string> {
  const claimed = new Set<string>();
  for (const block of turn.blocks) {
    if (block.kind === 'card' && block.card.primary.effect.kind === 'permission') {
      claimed.add(block.card.primary.effect.permission_id);
    }
  }
  return claimed;
}
