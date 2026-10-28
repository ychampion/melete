/**
 * What a room's members see of its threads and requests. The rooms routes
 * have already checked the viewer is in the room; everything here reads the
 * room's own rows with the existing projectors, and nothing from a person's
 * own space.
 */
import {
  conversationTurn,
  type ExperienceEvent,
  type ExperienceReceipt,
  type ExperienceSource,
  type PermissionCard,
  type ResultCard,
  type RoomMessage,
  type RoomRequest,
  type RoomThread,
  roomMessage as roomMessageContract,
  roomRequest,
  roomThread as roomThreadContract,
  TOOL_TITLE_LIMIT,
  type ToolCall,
} from '@melete/contracts';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { action, approval, artifact, connection, experienceTurn, job } from '../db/schema.ts';
import { answerStream } from '../experience/answer-filter.ts';
import {
  ACTION_VERBS,
  type ActionRow,
  actionLabel,
  answerText,
  meantForPerson,
  projectArtifact,
  projectCards,
  projectReceipt,
} from '../experience/projectors.ts';
import { conversationView } from '../experience/service.ts';
import type { JobRow } from '../jobs/service.ts';
import { ENDED_STATES } from '../jobs/withdraw.ts';
import type { roomMessage, roomThread } from './schema.ts';
import { namesOf } from './transcript.ts';

/** Turn statuses whose answer may still grow. */
const STILL_WRITING = new Set(['queued', 'working', 'streaming', 'stalled']);

const author = (names: ReadonlyMap<string, string>, id: string) => ({
  principal_id: id,
  display_name: names.get(id) ?? 'Someone',
});

export function threadView(
  row: typeof roomThread.$inferSelect,
  names: ReadonlyMap<string, string>,
): RoomThread {
  return roomThreadContract.parse({
    id: row.id,
    room_id: row.spaceId,
    title: row.title,
    created_by: author(names, row.createdBy),
    created_at: row.createdAt.toISOString(),
    last_activity_at: row.lastActivityAt.toISOString(),
    archived_at: row.archivedAt?.toISOString() ?? null,
  });
}

export function messageView(
  row: typeof roomMessage.$inferSelect,
  names: ReadonlyMap<string, string>,
): RoomMessage {
  return roomMessageContract.parse({
    id: row.id,
    thread_id: row.threadId,
    author: author(names, row.authorPrincipalId),
    kind: row.kind,
    via_agent: row.viaAgent,
    text: row.redactedAt ? null : row.text,
    mentions: row.mentions,
    request_state: row.requestState,
    request_job_id: row.requestJobId,
    created_at: row.createdAt.toISOString(),
  });
}

/**
 * One request as the room sees it: its turns and answers, and the cards and
 * receipts of what it did, including the command jobs it started.
 */
export async function requestView(
  db: Database,
  row: JobRow,
  names: ReadonlyMap<string, string>,
  /** The card of one of the room's waiting permissions; left out, none are shown. */
  permissionCard?: (approvalId: string) => Promise<PermissionCard>,
  /** The viewer reads the room's steps kept back (see `keptBackCard`). */
  keptBack = false,
): Promise<RoomRequest> {
  const turns = await db
    .select()
    .from(experienceTurn)
    .where(eq(experienceTurn.jobId, row.id))
    .orderBy(asc(experienceTurn.createdAt), asc(experienceTurn.id));
  const current = turns.find((turn) => turn.id === row.currentTurnId) ?? turns.at(-1) ?? null;
  const linked = await db
    .select({ id: job.id })
    .from(job)
    .where(and(eq(job.experienceParentId, row.id), eq(job.spaceId, row.spaceId)));
  const jobIds = [row.id, ...linked.map((entry) => entry.id)];
  const effects = await db
    .select({ action, connection })
    .from(action)
    .innerJoin(connection, eq(connection.id, action.connectionId))
    .where(and(inArray(action.jobId, jobIds), eq(connection.spaceId, row.spaceId)))
    .orderBy(asc(action.createdAt), asc(action.id));
  const files = await db
    .select()
    .from(artifact)
    .where(
      and(eq(artifact.spaceId, row.spaceId), or(...jobIds.map((id) => eq(artifact.jobId, id)))),
    );
  // Every permission the request and its steps asked for: those still waiting,
  // with who may answer them, and those answered, with who answered.
  const asked = await db
    .select({ approval, effect: action, owner: job })
    .from(approval)
    .innerJoin(action, eq(action.id, approval.actionId))
    .innerJoin(job, eq(job.id, action.jobId))
    .where(and(inArray(action.jobId, jobIds), eq(job.spaceId, row.spaceId)))
    .orderBy(asc(approval.requestedAt), asc(approval.id));
  const now = Date.now();
  const waiting = asked.filter(
    ({ approval: question, effect, owner }) =>
      question.decision === null &&
      effect.status === 'needs_approval' &&
      question.jobRevision === owner.revision &&
      !ENDED_STATES.includes(owner.state) &&
      (!question.expiresAt || question.expiresAt.getTime() > now),
  );
  const permissions = permissionCard
    ? await Promise.all(waiting.map(({ approval: question }) => permissionCard(question.id)))
    : [];
  const answered = asked.filter(({ approval: question }) => question.decision !== null);
  const deciders = await namesOf(
    db,
    row.spaceId,
    answered.flatMap(({ approval: question }) => (question.decidedBy ? [question.decidedBy] : [])),
  );
  const decisions = answered.map(({ approval: question }) => ({
    approval_id: question.id,
    decision: question.decision === 'approved' ? ('approved' as const) : ('denied' as const),
    // Only a person is named: a withdrawal or the room's settings name nobody.
    decided_by:
      question.decidedBy && deciders.has(question.decidedBy)
        ? author(deciders, question.decidedBy)
        : null,
    decided_at: (question.decidedAt ?? question.requestedAt).toISOString(),
  }));
  const receipts = effects.flatMap(({ action: effect, connection: source }) => {
    const receipt = projectReceipt(effect, source);
    if (!receipt) return [];
    return [keptBack ? keptBackReceipt(receipt, effect) : receipt];
  });
  return roomRequest.parse({
    job_id: row.id,
    requested_by: author(names, row.requestedByPrincipalId ?? ''),
    status: conversationView(row, current).status,
    turns: turns.map((turn) =>
      conversationTurn.parse({
        id: turn.id,
        conversation_id: turn.jobId,
        agent_id: turn.agentId,
        text: turn.text,
        answer: (STILL_WRITING.has(turn.status)
          ? answerStream(turn.answer)
          : answerText(turn.answer)
        ).trimStart(),
        status: turn.status,
        delivery: turn.status === 'queued' ? 'sending' : null,
        created_at: turn.createdAt.toISOString(),
      }),
    ),
    cards: [
      // A file a files action saved opens only for that job's own principal,
      // so a room's people see its card without the buttons.
      ...effects.flatMap(({ action: effect, connection: source }) =>
        projectCards(effect, source).map((card) => {
          const shown =
            card.primary_action?.handle === effect.id
              ? { ...card, primary_action: null, secondary_actions: [] }
              : card;
          return keptBack ? keptBackCard(shown, effect.kind) : shown;
        }),
      ),
      ...files.filter(meantForPerson).map(projectArtifact),
    ],
    receipts,
    permissions,
    decisions,
  });
}

/*
 * A room set to "Show me only what needs me" (spaces/summaries.ts) keeps its
 * originals back from its people, its maker apart. What its steps touched is
 * then named by its kind: a card, a receipt, a step in the live stream says
 * "An email" or "An event", never the original's subject, address or words.
 * What the agent made itself (an event it added, a file it wrote) keeps its
 * own title, and so does its answer.
 */

/** What a step's card calls the original it touched, by the step's kind. */
const KEPT_BACK_TITLES: Record<string, string> = {
  'email.search': 'An email',
  'email.read': 'An email',
  'email.draft': 'A draft email',
  'email.send': 'A sent email',
  'email.discard': 'A draft email',
  'calendar.list': 'An event',
  'calendar.update': 'An event',
  'calendar.delete': 'An event',
  'files.move': 'A file',
  'files.restore': 'A file',
  'files.delete': 'A file',
};

/** What a source of the trail is called, by what it is. Pages and tasks are not originals. */
const KEPT_BACK_SOURCES: Partial<Record<ExperienceSource['kind'], string>> = {
  message: 'An email',
  draft: 'A draft email',
  event: 'An event',
  file: 'A file',
};

/** The facts a kept-back card still shows: when, never where or to whom. */
const KEPT_BACK_FACTS = new Set(['Starts', 'Ends']);

/** Work outside the room's connections that can read an original by name. */
const KEPT_BACK_TOOLS: Partial<Record<ToolCall['kind'], string>> = {
  file: 'Worked with a file',
  sandbox: 'Worked in its computer',
  browser: 'Worked in its browser',
};

/** A step's card, as someone who may not read the originals sees it. */
export function keptBackCard(card: ResultCard, kind: string): ResultCard {
  const title = KEPT_BACK_TITLES[kind];
  if (!title) return card;
  return {
    ...card,
    title,
    facts: card.facts.filter((fact) => KEPT_BACK_FACTS.has(fact.label)),
    // An open goes to the original itself.
    primary_action: null,
    secondary_actions: [],
  };
}

/** A receipt names the step, never what a server's tool acted on. A web search keeps its words. */
export function keptBackReceipt(receipt: ExperienceReceipt, row: ActionRow): ExperienceReceipt {
  if (row.kind === 'web.search') return receipt;
  return { ...receipt, what: actionLabel(row, undefined, { target: false }) };
}

function keptBackSource(source: ExperienceSource): ExperienceSource {
  const title = KEPT_BACK_SOURCES[source.kind];
  if (!title) return source;
  const { url: _url, ...rest } = source;
  return { ...rest, title };
}

/** The action a tool entry stands for: its own, or the one it belongs under. */
const actionOfTool = (tool: ToolCall, rows: ReadonlyMap<string, ActionRow>) => {
  for (const id of [tool.id, tool.parent])
    if (id?.startsWith('action:')) {
      const row = rows.get(id.slice('action:'.length));
      if (row) return row;
    }
  return undefined;
};

function keptBackTool(tool: ToolCall, rows: ReadonlyMap<string, ActionRow>): ToolCall {
  const row = actionOfTool(tool, rows);
  const verbs = row ? ACTION_VERBS[row.kind] : undefined;
  const title = row
    ? (verbs?.[tool.status === 'running' || tool.status === 'needs_approval' ? 0 : 1] ??
      actionLabel(row, undefined, { target: false }))
    : (KEPT_BACK_TOOLS[tool.kind] ?? tool.title);
  const { input_excerpt: _input, output_excerpt: _output, ...rest } = tool;
  return {
    ...rest,
    title: title.slice(0, TOOL_TITLE_LIMIT),
    input_summary: null,
    output_summary: null,
    detail: null,
  };
}

/** The action ids one stream item names, so they can be read before it is shown. */
export function actionIdsOf(item: ExperienceEvent['item']): string[] {
  const fromTool = (tool: ToolCall | undefined) =>
    [tool?.id, tool?.parent].flatMap((id) =>
      id?.startsWith('action:') ? [id.slice('action:'.length)] : [],
    );
  if (item.type === 'card') return [item.card.id.split(':')[0] ?? ''];
  if (item.type === 'receipt') return [item.receipt.id];
  if (item.type === 'tool') return fromTool(item.tool);
  if (item.type === 'action') return fromTool(item.tool);
  return [];
}

/**
 * One item of a request's live stream, as someone who may not read the
 * originals sees it, or null when it is not shown to them at all. The
 * model's reasoning is its working, which may quote what it read; its
 * answer is what it wrote for the room.
 */
export function keptBackItem(
  item: ExperienceEvent['item'],
  rows: ReadonlyMap<string, ActionRow>,
): ExperienceEvent['item'] | null {
  switch (item.type) {
    case 'reasoning':
      return null;
    case 'card': {
      const row = rows.get(item.card.id.split(':')[0] ?? '');
      return row ? { ...item, card: keptBackCard(item.card, row.kind) } : item;
    }
    case 'receipt': {
      const row = rows.get(item.receipt.id);
      return row ? { ...item, receipt: keptBackReceipt(item.receipt, row) } : item;
    }
    case 'tool':
      return { ...item, tool: keptBackTool(item.tool, rows) };
    case 'action': {
      const tool = item.tool ? keptBackTool(item.tool, rows) : undefined;
      return {
        ...item,
        ...(tool ? { label: tool.title, meta: '', tool } : {}),
        sources: item.sources.map(keptBackSource),
      };
    }
    default:
      return item;
  }
}
