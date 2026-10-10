/**
 * Fold a conversation's saved turns and its events into the transcript the
 * screen draws. The same reducer runs over the replayed history and over the
 * live stream, so a reload and a reconnect produce the same picture. A gap is
 * kept on the transcript: text that streamed while the connection was down
 * is gone, and the interface says so rather than stitching halves.
 */
import type { MeleteEvent } from '@melete/client';
import type { ToolEntry } from './trace.ts';
import type {
  ComposerState,
  Draft,
  ExperienceDecision,
  ExperienceEvent,
  Permission,
  PermissionOption,
  Question,
  Reaction,
  Receipt,
  ResultCard,
  StreamGap,
  TrailStep,
  Turn,
  TurnStatus,
} from './types.ts';

export type TurnBlock =
  | { type: 'card'; card: ResultCard }
  | { type: 'receipt'; receipt: Receipt; reversed: boolean }
  /**
   * `decided` is the option chosen, here or as the stream's decision reports
   * it; `replaced` means a later message made the request stale; `withdrawn`
   * means the person stopped the turn while it waited; `outdated` means
   * something it relied on changed before anyone answered; `closed`
   * means its action moved on past approval without a decision item saying which way.
   */
  | {
      type: 'permission';
      permission: Permission;
      decided: PermissionOption | 'replaced' | 'withdrawn' | 'outdated' | 'closed' | null;
    }
  /**
   * `answered` is the option id, `withdrawn` when the person stopped the turn
   * while it waited, or `closed` when the turn moved on after an answer given elsewhere.
   */
  | { type: 'question'; question: Question; answered: string | null };

/**
 * What a turn did, in the order it happened: each stretch of the agent's own
 * words between two pieces of work is its own `text` entry, so a message
 * written before a tool call is never run together with the one after it.
 * Tool rows and blocks are named by id and read from `trail` and `blocks`,
 * which hold their latest copies. Reasoning has no place here.
 */
export type FlowEntry =
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string }
  | { type: 'step'; step: Exclude<TrailStep, { type: 'reasoning' }> }
  | { type: 'block'; id: string };

export type TranscriptTurn = {
  id: string;
  /** The person's message and the agent's saved answer, as the service holds them. */
  turn: Turn;
  /** Text streamed since the saved answer was read. */
  streamed: string;
  status: TurnStatus;
  trail: TrailStep[];
  blocks: TurnBlock[];
  /** Messages, work and blocks in the order they arrived. */
  flow: FlowEntry[];
  /** True while text_delta items are arriving for this turn. */
  streaming: boolean;
  delivery: Turn['delivery'];
  /** The first identified, nonempty text event in the answer, never a card or status. */
  messageSeq: number | null;
  /** The tool entry under way, from the stream's `tool` items: what is happening now. */
  live: { id: string; title: string } | null;
  /** Started elsewhere and drawn from its events; its saved text is still to be read. */
  unread?: boolean;
  /**
   * The saved copy said the turn had finished. Its events, replayed in order,
   * pass through "working" on the way to that end, and none of them makes a
   * finished turn read as working again.
   */
  finished?: boolean;
  /** The agent's copy of the conversation before this turn was summarised during it. */
  compacted?: true;
  /** When the stream said the turn ended, so a stopped turn reports the time it really took. */
  ended_at?: string;
};

export type ReactionMessage = {
  conversationId: string;
  turnId: string | null;
  author: 'person' | 'assistant';
  text: string;
  createdAt: string;
};

export type Transcript = {
  turns: TranscriptTurn[];
  gaps: StreamGap[];
  lastSeq: number;
  composer: ComposerState;
  status: TurnStatus;
  /** Drafts this conversation holds, keyed by id, refreshed after a send. */
  drafts: Record<string, Draft>;
  /** Message identities retained from the two event streams, keyed by their actual seq. */
  messages: Record<string, ReactionMessage>;
  /** The permission each waiting action entry points at, keyed by the entry's id. */
  approvals: Record<string, string>;
};

export const emptyTranscript = (): Transcript => ({
  turns: [],
  gaps: [],
  lastSeq: 0,
  composer: 'send',
  status: 'idle',
  drafts: {},
  messages: {},
  approvals: {},
});

const fromTurn = (turn: Turn): TranscriptTurn => ({
  id: turn.id,
  turn,
  streamed: '',
  status: turn.status,
  trail: [],
  blocks: [],
  flow: [],
  streaming: false,
  delivery: turn.delivery,
  messageSeq: null,
  live: null,
  ...(FINAL.has(turn.status) ? { finished: true } : {}),
});

/**
 * A replayed status of a turn whose saved copy already finished: it is history,
 * and says nothing about whether the conversation is working now.
 */
export function replayedStatus(transcript: Transcript, event: ExperienceEvent): boolean {
  if (event.item.type !== 'status' || FINAL.has(event.item.status)) return false;
  const turn = transcript.turns.find((entry) => entry.id === event.turn_id);
  return turn?.finished === true;
}

export function fromTurns(turns: Turn[], composer: ComposerState, status: TurnStatus): Transcript {
  return { ...emptyTranscript(), turns: turns.map(fromTurn), composer, status };
}

type ReceiptBlock = Extract<TurnBlock, { type: 'receipt' }>;

/** Every receipt in the transcript, through `change`. */
function mapReceipts(
  transcript: Transcript,
  change: (block: ReceiptBlock) => ReceiptBlock,
): Transcript {
  return {
    ...transcript,
    turns: transcript.turns.map((turn) => ({
      ...turn,
      blocks: turn.blocks.map((block) => (block.type === 'receipt' ? change(block) : block)),
    })),
  };
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

/**
 * The saved answer plus what streamed after it was read, never doubled. The
 * stream can carry the whole answer again, or more than the saved copy around
 * it, so when one holds the other only the longer one is shown. A finished
 * turn's saved answer is the whole of it: what was written before an approval
 * ("Waiting on your approval…") is not shown above the final answer.
 */
export function answerOf(turn: TranscriptTurn): string {
  const answer = turn.turn.answer;
  const streamed = turn.streamed;
  if (answer && FINAL.has(turn.status)) return answer;
  if (!streamed) return answer;
  if (!answer) return streamed;
  if (streamed.includes(answer)) return streamed;
  if (answer.includes(streamed)) return answer;
  return answer + streamed;
}

/** A turn the service has finished: its saved answer is the whole of it. */
const FINAL = new Set<TurnStatus>(['done', 'failed', 'stopped']);

/** A card, receipt, permission or question already drawn is not drawn twice. */
export const blockId = (block: TurnBlock): string =>
  block.type === 'card'
    ? block.card.id
    : block.type === 'receipt'
      ? block.receipt.id
      : block.type === 'permission'
        ? block.permission.id
        : block.question.id;

const hasBlock = (transcript: Transcript, id: string): boolean =>
  transcript.turns.some((turn) => turn.blocks.some((block) => blockId(block) === id));

/**
 * A turn this page did not start: a message sent from another tab, another
 * device or the service itself. Its events arrive before its saved text is
 * read, so it starts with no text and `unread`, and the text is filled in by
 * `fillTurns` once the saved turn is read.
 */
function ensureTurn(transcript: Transcript, event: ExperienceEvent): Transcript {
  const turnId = event.turn_id;
  if (!turnId || transcript.turns.some((turn) => turn.id === turnId)) return transcript;
  const turn: Turn = {
    id: turnId,
    conversation_id: event.conversation_id,
    agent_id: transcript.turns.at(-1)?.turn.agent_id ?? '',
    text: '',
    answer: '',
    status: 'queued',
    delivery: null,
    created_at: event.created_at,
  };
  return { ...transcript, turns: [...transcript.turns, { ...fromTurn(turn), unread: true }] };
}

/** The ids of turns whose saved text has not been read yet. */
export const unreadTurns = (transcript: Transcript): string[] =>
  transcript.turns.filter((turn) => turn.unread).map((turn) => turn.id);

/**
 * Take the saved answers of turns that have finished, read once they end: the
 * saved copy keeps only the final message, which replaces what streamed. A
 * turn waiting on the person has stopped writing too, and its saved copy is
 * what it said up to there, whole: it replaces what streamed, which can start
 * part way through a sentence, and anything said after it resumes is added.
 */
export function fillAnswers(transcript: Transcript, saved: Turn[]): Transcript {
  return {
    ...transcript,
    turns: transcript.turns.map((turn) => {
      const copy = saved.find((entry) => entry.id === turn.id);
      if (!copy?.answer) return turn;
      if (FINAL.has(copy.status) && FINAL.has(turn.status))
        return { ...turn, finished: true, turn: { ...turn.turn, answer: copy.answer } };
      if (copy.status === 'needs_you' && turn.status === 'needs_you')
        return { ...turn, streamed: '', turn: { ...turn.turn, answer: copy.answer } };
      return turn;
    }),
  };
}

/** Fill in turns started elsewhere from their saved copies: the message, and who answers it. */
export function fillTurns(transcript: Transcript, saved: Turn[]): Transcript {
  return {
    ...transcript,
    turns: transcript.turns.map((turn) => {
      const copy = turn.unread ? saved.find((entry) => entry.id === turn.id) : undefined;
      return copy
        ? {
            ...turn,
            unread: false,
            turn: {
              ...turn.turn,
              text: copy.text,
              agent_id: copy.agent_id,
              created_at: copy.created_at,
            },
          }
        : turn;
    }),
  };
}

export function applyEvent(transcript: Transcript, event: ExperienceEvent): Transcript {
  // An event already applied is not applied again: a stream reopened after
  // the history was read, or read twice, replays events this page has, and
  // their text would be added a second time.
  if (transcript.lastSeq > 0 && event.seq <= transcript.lastSeq) return transcript;
  transcript = ensureTurn(transcript, event);
  const lastSeq = Math.max(transcript.lastSeq, event.seq);
  const item = event.item;
  let base = { ...transcript, lastSeq };
  if (item.type === 'text_delta' && item.text.trim() && event.turn_id !== null) {
    base = rememberMessage(base, event.seq, {
      conversationId: event.conversation_id,
      turnId: event.turn_id,
      author: 'assistant',
      text: item.text,
      createdAt: event.created_at,
    });
    base = patchTurn(base, event.turn_id, (turn) =>
      turn.messageSeq === null ? { ...turn, messageSeq: event.seq } : turn,
    );
  }
  // A receipt comes again when what it shows moves on: a held message is sent
  // or cancelled. The newer one takes the older one's place.
  if (item.type === 'receipt' && hasBlock(base, item.receipt.id))
    return mapReceipts(base, (block) =>
      block.receipt.id === item.receipt.id ? { ...block, receipt: item.receipt } : block,
    );
  if (
    (item.type === 'card' && hasBlock(base, item.card.id)) ||
    (item.type === 'permission' && hasBlock(base, item.permission.id)) ||
    (item.type === 'question' && hasBlock(base, item.question.id))
  )
    return base;
  // The stream says which way a decision went, so the card shows that outcome,
  // after a reload too, rather than only that the turn moved on.
  if (item.type === 'decision') return applyDecision(base, item.decision);
  // A permission stays open until the service says it was settled: a decision
  // item, wherever the person decided, or the action entry that pointed at it
  // finishing. Nothing else closes it. The model keeps writing its answer after
  // a tool call comes back "needs approval", memory and model entries land
  // while the person decides, and the waiting action's own entry can be read
  // again as under way, so none of these says anything about the request.
  if (item.type === 'tool') {
    const tool = item.tool;
    const { [tool.id]: pending, ...others } = base.approvals;
    if (tool.status === 'needs_approval' && tool.detail?.type === 'permission')
      return applyItem({ ...base, approvals: { ...others, [tool.id]: tool.detail.id } }, event);
    if (pending === undefined || tool.status === 'running') return applyItem(base, event);
    return applyItem(
      patchTurn({ ...base, approvals: others }, event.turn_id, (turn) => ({
        ...turn,
        blocks: turn.blocks.map((block) =>
          block.type === 'permission' && block.permission.id === pending && block.decided === null
            ? { ...block, decided: 'closed' }
            : block,
        ),
      })),
      event,
    );
  }
  // A question can be settled without an item of its own (a correction made
  // elsewhere answers it), so while it waits, anything but the status that
  // says so, a pause or a step means it was answered somewhere else.
  const stillWaiting =
    (item.type === 'status' && ['needs_you', 'paused', 'queued', 'idle'].includes(item.status)) ||
    (item.type === 'action' && item.tool !== undefined);
  const waited = stillWaiting
    ? base
    : patchTurn(base, event.turn_id, (turn) => ({
        ...turn,
        blocks: turn.blocks.map((block) =>
          block.type === 'question' && block.answered === null
            ? { ...block, answered: 'closed' }
            : block,
        ),
      }));
  return applyItem(waited, event);
}

/** The turn statuses in which a tool entry can still be under way. */
const UNDER_WAY = new Set<TurnStatus>(['queued', 'working', 'streaming', 'stalled', 'paused']);

type ToolStep = Extract<TrailStep, { type: 'action' }> & { tool: ToolEntry };
const ENDED = new Set(['done', 'failed', 'unknown']);

/**
 * Whether a tool entry is a row of the turn's activity. The model's own calls
 * mark steps rather than being one, and a scheduled retry is plumbing; a wait
 * for the person's computer is something they can act on, so it shows.
 */
export const isActivity = (tool: ToolEntry): boolean =>
  tool.kind !== 'model' && (tool.kind !== 'retry' || tool.id.startsWith('wait:'));

/**
 * The newer of two copies of one entry. Copies arrive in stream order, but a
 * finished entry is never taken back to under way by a copy read again later,
 * such as a replayed running copy after the finished one.
 */
export function newerTool(shown: ToolEntry, next: ToolEntry): ToolEntry {
  return ENDED.has(shown.status) && !ENDED.has(next.status) ? shown : next;
}

/**
 * Put a tool entry in the turn's activity: a new row where it first appeared,
 * or the latest copy in the row it already has.
 */
function placeTool(trail: TrailStep[], tool: ToolEntry): TrailStep[] {
  if (!isActivity(tool)) return trail;
  const index = trail.findIndex((step) => step.type === 'action' && step.tool?.id === tool.id);
  if (index < 0) {
    const row: ToolStep = { type: 'action', label: tool.title, meta: '', sources: [], tool };
    return [...trail, row];
  }
  const current = trail[index] as ToolStep;
  const latest = newerTool(current.tool, tool);
  if (latest === current.tool) return trail;
  const next = trail.slice();
  next[index] = { ...current, label: latest.title, tool: latest };
  return next;
}

/** A tool entry's row is placed, and the flow names it where it first appeared. */
function withTool(turn: TranscriptTurn, tool: ToolEntry): TranscriptTurn {
  const trail = placeTool(turn.trail, tool);
  if (trail.length <= turn.trail.length) return { ...turn, trail };
  return { ...turn, trail, flow: [...turn.flow, { type: 'tool', id: tool.id }] };
}

/**
 * Add streamed words to the flow: to the message being written, or as a new
 * message when work came between. A restart drops what the lost attempt said.
 */
export function flowText(flow: FlowEntry[], text: string, restart = false): FlowEntry[] {
  const kept = restart ? flow.filter((entry) => entry.type !== 'text') : flow;
  const last = kept.at(-1);
  if (last?.type === 'text' && !restart)
    return [...kept.slice(0, -1), { type: 'text', text: last.text + text }];
  if (!text.trim()) return kept;
  return [...kept, { type: 'text', text }];
}

function applyItem(base: Transcript, event: ExperienceEvent): Transcript {
  const item = event.item;
  switch (item.type) {
    case 'action':
      // A finished step that is one tool entry joins that entry's row.
      if (item.tool) {
        const tool = item.tool;
        return patchTurn(base, event.turn_id, (turn) => withTool(turn, tool));
      }
      return patchTurn(base, event.turn_id, (turn) => ({
        ...turn,
        trail: [...turn.trail, item],
        flow: [...turn.flow, { type: 'step', step: item }],
      }));
    case 'say':
    case 'note':
    case 'done':
      return patchTurn(base, event.turn_id, (turn) => ({
        ...turn,
        trail: [...turn.trail, item],
        flow: [...turn.flow, { type: 'step', step: item }],
        streaming: item.type === 'done' ? false : turn.streaming,
      }));
    case 'reasoning':
      return patchTurn(base, event.turn_id, (turn) => {
        const last = turn.trail.at(-1);
        return {
          ...turn,
          trail:
            last?.type === 'reasoning'
              ? [...turn.trail.slice(0, -1), { type: 'reasoning', text: last.text + item.text }]
              : [...turn.trail, item],
        };
      });
    case 'text_delta':
      return patchTurn(base, event.turn_id, (turn) =>
        // A finished turn read with its saved answer already holds this text,
        // and it is not working again; its flow still learns where each message fell.
        FINAL.has(turn.status) && turn.turn.answer
          ? { ...turn, flow: flowText(turn.flow, item.text, item.restart) }
          : {
              ...turn,
              flow: flowText(turn.flow, item.text, item.restart),
              // A retried turn's answer replaces the lost attempt's partial one.
              streamed: item.restart ? item.text : turn.streamed + item.text,
              streaming: true,
            },
      );
    case 'card':
      return patchTurn(base, event.turn_id, (turn) => ({
        ...turn,
        blocks: [...turn.blocks, { type: 'card', card: item.card }],
        flow: [...turn.flow, { type: 'block', id: item.card.id }],
      }));
    case 'receipt': {
      // An undo names the change it took back, wherever that is drawn.
      const reverses = item.receipt.reverses;
      if (reverses)
        base = mapReceipts(base, (block) =>
          block.receipt.id === reverses ? { ...block, reversed: true } : block,
        );
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
        flow: [...turn.flow, { type: 'block', id: item.receipt.id }],
      }));
    }
    case 'permission':
      return patchTurn(base, event.turn_id, (turn) => ({
        ...turn,
        blocks: [
          ...turn.blocks,
          { type: 'permission', permission: item.permission, decided: null },
        ],
        flow: [...turn.flow, { type: 'block', id: item.permission.id }],
      }));
    case 'question':
      return patchTurn(base, event.turn_id, (turn) => ({
        ...turn,
        blocks: [...turn.blocks, { type: 'question', question: item.question, answered: null }],
        flow: [...turn.flow, { type: 'block', id: item.question.id }],
      }));
    case 'status': {
      if (replayedStatus(base, event)) return base;
      // A status replayed for an earlier turn says nothing about the conversation
      // now: a long history opened mid-replay would otherwise read as working.
      const index = event.turn_id ? base.turns.findIndex((t) => t.id === event.turn_id) : -1;
      const earlier = index >= 0 && index < base.turns.length - 1;
      const next = earlier ? base : { ...base, composer: item.composer, status: item.status };
      return patchTurn(next, event.turn_id, (turn) => ({
        ...turn,
        status: item.status,
        ...(FINAL.has(item.status) ? { ended_at: event.created_at } : {}),
        streaming: item.status === 'streaming' ? turn.streaming : false,
        // Nothing is under way once the turn stops running, whatever the last entry said.
        live: UNDER_WAY.has(item.status) ? turn.live : null,
        // A turn read while still queued says "sending"; once the service moves it on, it was sent.
        ...(turn.delivery === 'sending' && item.status !== 'queued'
          ? { delivery: null, turn: { ...turn.turn, status: item.status, delivery: null } }
          : { turn: { ...turn.turn, status: item.status } }),
      }));
    }
    case 'compacted':
      return patchTurn(base, event.turn_id, (turn) =>
        turn.compacted ? turn : { ...turn, compacted: true },
      );
    case 'tool': {
      const tool = item.tool;
      const underWay = tool.status === 'running' || tool.status === 'needs_approval';
      return patchTurn(base, event.turn_id, (turn) => ({
        ...withTool(turn, tool),
        live: underWay
          ? { id: tool.id, title: tool.title }
          : turn.live?.id === tool.id
            ? null
            : turn.live,
      }));
    }
    default:
      return base;
  }
}

export function applyEvents(transcript: Transcript, events: ExperienceEvent[]): Transcript {
  return events.reduce(applyEvent, transcript);
}

/** A turn read from the service's saved copy, rather than drawn from events or sent here. */
const savedTurn = (transcript: Transcript, turnId: string | null): TranscriptTurn | undefined => {
  const turn = turnId ? transcript.turns.find((entry) => entry.id === turnId) : undefined;
  return turn && !turn.unread && !turn.id.startsWith('local_') ? turn : undefined;
};

/**
 * Replay a conversation's history over its saved turns. The saved copy and the
 * conversation's own status are the latest known state, so a status the history
 * passes through ("working" on the way to "needs you") never shows: the turn and
 * the composer keep what the service said. Everything else a status implies, such
 * as a question it shows was answered elsewhere, is kept. Statuses of turns the
 * saved copy did not have are applied as they come.
 */
export function applyHistory(transcript: Transcript, events: ExperienceEvent[]): Transcript {
  return events.reduce((current, event) => {
    const held = event.item.type === 'status' ? savedTurn(current, event.turn_id) : undefined;
    const next = applyEvent(current, event);
    if (!held || next === current) return next;
    return {
      ...next,
      composer: current.composer,
      status: current.status,
      turns: next.turns.map((turn) =>
        turn.id === held.id
          ? {
              ...turn,
              status: held.status,
              streaming: held.streaming,
              live: held.live,
              delivery: held.delivery,
              turn: held.turn,
            }
          : turn,
      ),
    };
  }, transcript);
}

/**
 * Take the statuses of a fresh read of the saved turns and the conversation,
 * once the history has been replayed: anything that changed while it was read
 * is in this copy.
 */
export function adoptSaved(
  transcript: Transcript,
  saved: Turn[],
  composer: ComposerState,
  status: TurnStatus,
): Transcript {
  return {
    ...transcript,
    composer,
    status,
    turns: transcript.turns.map((turn) => {
      const copy = saved.find((entry) => entry.id === turn.id);
      if (!copy || turn.unread) return turn;
      return {
        ...turn,
        status: copy.status,
        streaming: false,
        live: UNDER_WAY.has(copy.status) ? turn.live : null,
        delivery: copy.delivery,
        turn: {
          ...turn.turn,
          status: copy.status,
          delivery: copy.delivery,
          answer: copy.answer || turn.turn.answer,
        },
        ...(FINAL.has(copy.status) ? { finished: true } : {}),
      };
    }),
  };
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
  receivedAt: string,
): Transcript {
  // The stream can deliver this turn's first events before the send is
  // answered; they started a turn of their own under the same id, which the
  // local turn takes over so nothing is drawn twice.
  const early = transcript.turns.find((t) => t.id === turnId && t.unread);
  return {
    ...transcript,
    turns: transcript.turns
      .filter((t) => t !== early)
      .map((t) =>
        t.id === localId
          ? {
              ...t,
              ...(early
                ? {
                    streamed: early.streamed,
                    status: early.status,
                    trail: early.trail,
                    blocks: early.blocks,
                    flow: early.flow,
                    streaming: early.streaming,
                    messageSeq: early.messageSeq,
                    live: early.live,
                  }
                : {}),
              id: turnId,
              delivery: null,
              turn: { ...t.turn, id: turnId, delivery: null, created_at: receivedAt },
            }
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
  option: PermissionOption | 'replaced' | 'withdrawn' | 'outdated',
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

/**
 * Apply a decision from the stream. A permission takes its outcome. A question
 * takes the option whose words were chosen; a withdrawn question, or an answer
 * given in the person's own words, closes without naming an option.
 */
export function applyDecision(transcript: Transcript, decision: ExperienceDecision): Transcript {
  if (decision.kind === 'permission') {
    return decision.outcome === 'allow_once' ||
      decision.outcome === 'always' ||
      decision.outcome === 'deny' ||
      decision.outcome === 'replaced' ||
      decision.outcome === 'withdrawn' ||
      decision.outcome === 'outdated'
      ? markPermission(transcript, decision.id, decision.outcome)
      : transcript;
  }
  const question = transcript.turns
    .flatMap((turn) => turn.blocks)
    .find((block) => block.type === 'question' && block.question.id === decision.id);
  const chosen =
    decision.outcome === 'answered' && decision.answer !== null && question?.type === 'question'
      ? question.question.options.find(
          (option) =>
            option.label === decision.answer || option.label.split(' · ')[0] === decision.answer,
        )
      : undefined;
  // A question withdrawn by a stop says so, rather than reading as answered elsewhere.
  return markQuestion(
    transcript,
    decision.id,
    chosen?.id ?? (decision.outcome === 'withdrawn' ? 'withdrawn' : 'closed'),
  );
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

function rememberMessage(
  transcript: Transcript,
  seq: number,
  message: ReactionMessage,
): Transcript {
  if (!Number.isSafeInteger(seq) || seq < 1) return transcript;
  return { ...transcript, messages: { ...transcript.messages, [seq]: message } };
}

/** Keep only message identity from the job stream; internal events never become visible text. */
export function applyMessageEvent(transcript: Transcript, event: MeleteEvent): Transcript {
  if (!event.job_id) return transcript;
  const payload = event.payload;
  if (
    (payload.kind === 'user_message' || payload.from === 'owner') &&
    typeof payload.text === 'string' &&
    payload.text.trim()
  ) {
    return rememberMessage(transcript, event.seq, {
      conversationId: event.job_id,
      turnId: typeof payload.turn_id === 'string' ? payload.turn_id : null,
      author: 'person',
      text: payload.text,
      createdAt: event.created_at,
    });
  }
  const item = payload.item;
  if (
    payload.kind === 'experience' &&
    typeof payload.turn_id === 'string' &&
    item &&
    typeof item === 'object' &&
    !Array.isArray(item) &&
    item.type === 'text_delta' &&
    typeof item.text === 'string' &&
    item.text.trim()
  ) {
    const message: ReactionMessage = {
      conversationId: event.job_id,
      turnId: payload.turn_id,
      author: 'assistant',
      text: item.text,
      createdAt: event.created_at,
    };
    const next = rememberMessage(transcript, event.seq, message);
    // A projection has its own seq; an existing reaction may name the source text instead.
    return typeof payload.source_seq === 'number'
      ? rememberMessage(next, payload.source_seq, message)
      : next;
  }
  return transcript;
}

/** Only a completed answer with an identified text event can receive a reaction. */
export function reactionMessageSeq(turn: TranscriptTurn): number | null {
  return ['done', 'stopped', 'failed'].includes(turn.status) && answerOf(turn).trim()
    ? turn.messageSeq
    : null;
}

/** Resolve the actual target record. Event ordering and matching prose alone are not identity. */
export function turnIndexForReaction(transcript: Transcript, reaction: Reaction): number {
  const message = transcript.messages[reaction.message_id];
  if (!message || message.conversationId !== reaction.job_id || message.author === reaction.by)
    return -1;
  const matches = transcript.turns.flatMap((turn, index) => {
    if (turn.turn.conversation_id !== message.conversationId) return [];
    if (message.turnId !== null) return turn.id === message.turnId ? [index] : [];
    // The service writes the accepted turn and user_message in one transaction;
    // both carry that transaction's timestamp. Repeated or incomplete matches stay hidden.
    return message.author === 'person' &&
      turn.turn.text === message.text &&
      turn.turn.created_at === message.createdAt
      ? [index]
      : [];
  });
  return matches.length === 1 ? (matches[0] ?? -1) : -1;
}
