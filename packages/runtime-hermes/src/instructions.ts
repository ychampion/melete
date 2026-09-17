/**
 * What one attempt is told, and in what order.
 *
 * Hermes appends the run's `instructions` into the context tier of its own
 * system prompt rather than replacing it (`agent/system_prompt.py:638`), so
 * everything here is additive: the engine's preamble is underneath, and this is
 * the part Melete owns. The engine contributes its own preamble in addition to
 * the bounded skills and recalled knowledge supplied by the service. The
 * representative Melete scaffolding must remain below 4,000 estimated tokens;
 * its tripwire includes both rendered halves and tool definitions, excluding
 * only transcript content and knowledge excerpt bodies.
 *
 * Order matters for prompt caching. The identity never changes, the skills
 * change rarely, the knowledge changes per attempt, and the volatile inputs go
 * last, so the longest stable prefix is as long as it can be.
 */
import { type AttemptBundle, CONTEXT_LIMITS, renderSinceLast } from '@melete/contracts';
import { estimateTokens, loadIdentity } from '@melete/skills';

/**
 * Who Melete is, read from the one file that defines it rather than copied.
 * `loadIdentity` refuses a file over the 250-token cap, so a drifting identity
 * fails at the boundary instead of quietly eating the context budget.
 */
export const IDENTITY: string = loadIdentity();

/** A run's `instructions`: identity, then procedure, then what is already known. */
export function renderInstructions(bundle: AttemptBundle): string {
  const identity = bundle.identity ?? IDENTITY;
  if (estimateTokens(identity) > 250)
    throw new Error('The agent identity exceeds its 250-token cap.');
  const parts = [identity];

  if (bundle.skills.length > 0) {
    // The service has already applied the at-most-three rule; this only renders.
    parts.push(
      `# How to do this kind of work\n\n${bundle.skills
        .map((skill) => `## ${skill.name}\n\n${skill.body}`)
        .join('\n\n')}`,
    );
  }

  if (bundle.knowledge.length > 0) {
    // Provenance travels with every excerpt. A model that cannot see where a
    // fact came from cannot tell the owner, and an unattributed fact in a
    // summary is indistinguishable from one the model made up.
    parts.push(
      `# What Melete already knows\n\nEach line is a record, not a belief. Name a path only when asked where something came from or when it is disputed.\n\n${bundle.knowledge
        .map(
          (entry) =>
            `- ${entry.handle ? `[${entry.handle}] ` : ''}${entry.path} (${entry.provenance.asserted_by}, ${entry.provenance.observed_at}, ${entry.provenance.status}): ${entry.excerpt}`,
        )
        .join('\n')}`,
    );
  }

  parts.push(WORKSPACE_NOTE(bundle));
  return parts.join('\n\n');
}

/**
 * The one thing about the environment the model cannot infer: the workspace is
 * the only writable place, and the broker is the only way out.
 */
const WORKSPACE_NOTE = (bundle: AttemptBundle): string =>
  [
    '# This attempt',
    '',
    `Workspace: ${bundle.workspace.mount}. It is the only path you can write to.`,
    `Budget: at most ${bundle.budget.max_turns} turns and ${bundle.budget.max_actions} actions.`,
    'Every tool call is proposed to the broker, which records it and may need the',
    "owner's approval. A tool that answers `needs_approval` has NOT happened: stop,",
    'say what you are waiting on, and end your turn.',
    'Reusable owner corrections go through learning.propose when it is in the catalog.',
    'It refers the recorded intervention for evaluation; it never installs a live skill.',
  ].join('\n');

/**
 * The job's constraints as the model reads them: one short line each, and a
 * default is not written down. An empty domain list limits web fetches in a job
 * that carries private context and nothing else; printed as `[]` it reads as a
 * ban on acting at all. A key this does not know is still shown.
 */
export function renderConstraints(constraints: AttemptBundle['job']['constraints']): string[] {
  const { deliverable, allowed_domains, public_compartment, notes, ...rest } = constraints;
  const lines: string[] = [];
  const done = deliverable as { kind?: string; path_glob?: string; connection_id?: string } | null;
  if (done?.kind === 'artifact')
    lines.push(`- Done means a file matching ${done.path_glob} exists in the workspace.`);
  else if (done?.kind === 'message_sent')
    lines.push(`- Done means a message was sent through ${done.connection_id}.`);
  else if (done?.kind === 'answer') lines.push('- Done means the owner has an answer.');
  if (public_compartment === true)
    lines.push(
      '- Public research: no private knowledge is loaded, and any public site may be read.',
    );
  else if (Array.isArray(allowed_domains) && allowed_domains.length > 0)
    lines.push(`- Web fetches may reach only these domains: ${allowed_domains.join(', ')}.`);
  if (typeof notes === 'string' && notes.trim()) lines.push(`- ${notes.trim()}`);
  for (const [key, value] of Object.entries(rest))
    lines.push(`- ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  return lines;
}

/** The volatile half: the job, and what changed since the last attempt. */
export function renderInput(bundle: AttemptBundle): string {
  const lines = [`# ${bundle.job.title}`, '', bundle.job.objective];
  const constraints = renderConstraints(bundle.job.constraints);
  if (constraints.length) lines.push('', '## Accepted constraints', '', ...constraints);
  if (bundle.job.triggers?.length)
    lines.push(
      '',
      '## Events this job can wait for',
      '',
      ...bundle.job.triggers.map(
        (entry) => `- ${entry.id}: ${entry.event_name ?? entry.kind}, ${entry.description}`,
      ),
      'job.wait takes the trigger id or the event name.',
    );
  // Disposable engines have no session history. The service's bounded ledger
  // is the source of prior messages and completed tool-call identities.
  if (bundle.transcript.length)
    lines.push('', '## Prior conversation and tool results', '', JSON.stringify(bundle.transcript));
  for (const brief of bundle.inputs.repair_briefs)
    lines.push('', '## Repair required', '', JSON.stringify(brief));

  if (bundle.job.progress_summary) {
    lines.push('', '## Where this got to', '', bundle.job.progress_summary);
  }
  if (bundle.job.unresolved_questions.length > 0) {
    lines.push(
      '',
      '## Still open',
      '',
      ...bundle.job.unresolved_questions.map((question) => `- ${question}`),
    );
  }

  // The durable delta must reach the run's prompt, not just its service-side bundle.
  lines.push('', renderSinceLast(bundle.since_last));

  // The reason this wake exists goes last, because it is what the model should
  // act on first and recency is what it reads as urgency.
  const cancelled = bundle.inputs.cancelled_wait;
  if (cancelled?.kind === 'event' || cancelled?.kind === 'timer') {
    const named = bundle.job.triggers?.find(
      (entry) => cancelled.kind === 'event' && entry.id === cancelled.trigger_id,
    );
    const what =
      cancelled.kind === 'timer'
        ? `until ${cancelled.wake_at}`
        : `for ${named?.event_name ?? 'its trigger'} (${cancelled.trigger_id})`;
    lines.push(
      '',
      '## A wait was cancelled',
      '',
      `The wait ${what} was cancelled before it fired. No wait is in force now, whatever an earlier wait result says; if this job still needs it, call job.wait again.`,
    );
  }
  for (const approval of bundle.inputs.approval_results)
    lines.push('', '## A decision was made', '', renderDecision(approval));
  for (const event of bundle.inputs.trigger_events) {
    lines.push('', '## Something happened', '', JSON.stringify(event));
  }
  for (const message of bundle.inputs.new_user_messages) {
    lines.push('', '## From the owner', '', message.content);
  }

  return lines.join('\n');
}

const DECISION_PAYLOAD_CHARACTERS = 2000;

/**
 * One decision, with what it was about. An approved action that has not left
 * yet is carried out by id: the broker sends the bytes the owner read, so the
 * model is told to resume it and is never asked to reproduce them.
 */
function renderDecision(approval: AttemptBundle['inputs']['approval_results'][number]): string {
  const what = approval.kind ? `${approval.action_id} (${approval.kind})` : approval.action_id;
  const note = approval.note ? ` The owner said: ${approval.note}` : '';
  if (approval.decision === 'denied')
    return `${what} was denied. It was not carried out and it will not be.${note}`;
  if (approval.status === undefined) return `${what} was approved.${note}`;
  if (approval.status !== 'approved')
    return `${what} was approved; it is now ${approval.status}.${note}`;
  const serialized = JSON.stringify(approval.payload ?? {});
  const payload =
    serialized.length > DECISION_PAYLOAD_CHARACTERS
      ? `${serialized.slice(0, DECISION_PAYLOAD_CHARACTERS)} [payload abbreviated; the stored bytes are sent whole]`
      : serialized;
  return [
    `${what} was approved and has not been carried out.${note}`,
    `Call resume_action with action_id "${approval.action_id}" to carry out exactly what was approved: ${payload}`,
    'Do not propose the tool again with retyped arguments; different bytes are a different action and need a new approval.',
  ].join('\n');
}

/**
 * Measure the whole Melete render. This is a chars/4 size tripwire, not gateway
 * admission accounting. Hermes contributes an additional engine-owned preamble.
 */
export function measureRenderedInput(bundle: AttemptBundle) {
  const rendered = [
    renderInstructions(bundle),
    renderInput(bundle),
    JSON.stringify(bundle.tools),
  ].join('\n\n');
  const transcriptChars = bundle.transcript.length ? JSON.stringify(bundle.transcript).length : 0;
  const knowledgeChars = bundle.knowledge.reduce((sum, entry) => sum + entry.excerpt.length, 0);
  return {
    total: estimateTokens(rendered),
    // Keep headings, provenance, constraints, changes and repair briefs charged.
    scaffolding: Math.ceil((rendered.length - transcriptChars - knowledgeChars) / 4),
  };
}

export const instructionTokens = (bundle: AttemptBundle): number =>
  measureRenderedInput(bundle).total;

/** The identity's share of that, checked against the contract on every build. */
export const IDENTITY_TOKENS: number = estimateTokens(IDENTITY);

if (IDENTITY_TOKENS > CONTEXT_LIMITS.identity_tokens) {
  throw new Error(
    `the identity is about ${IDENTITY_TOKENS} tokens; the contract caps it at ${CONTEXT_LIMITS.identity_tokens}`,
  );
}
