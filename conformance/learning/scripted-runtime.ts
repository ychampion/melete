import {
  type AttemptBundle,
  dedupKey,
  type EventSink,
  type RuntimeAdapter,
} from '@melete/contracts';
import { recordTask, TASK_PREFIX } from './records.ts';
import {
  type StepForm,
  sortRows,
  stepsFromBody,
  stepsFromMessage,
  writeDraft,
} from './step-interpreter.ts';

/**
 * A deterministic provider fixture. It has no expected answers, validation
 * templates or sealed tasks in its implementation, and it does not look for
 * phrases in what it was delivered: it reads delivered skill bodies and the
 * owner's new messages as steps (see `step-interpreter.ts`) and applies them.
 * With no steps it gives its default answer, which is what the baseline arm of
 * an evaluation receives.
 */
export class ScriptedRecordRuntime implements RuntimeAdapter {
  readonly observed: AttemptBundle[] = [];
  async capabilities() {
    return {
      version: 'scripted-records/1',
      tools: true,
      streaming: false,
      interrupt: true,
      workspace: 'job' as const,
    };
  }
  async start(bundle: AttemptBundle, sink: EventSink, signal: AbortSignal) {
    signal.throwIfAborted();
    this.observed.push(structuredClone(bundle));
    const steps: StepForm[] = [
      ...bundle.skills.flatMap((skill) => stepsFromBody(skill.body)),
      ...bundle.inputs.new_user_messages.flatMap((message) => stepsFromMessage(message.content)),
    ];
    const summary = bundle.job.objective.startsWith(TASK_PREFIX)
      ? arrange(bundle.job.objective, steps)
      : writeDraft(bundle.job.objective, steps);
    const outcome = { kind: 'completed' as const, summary, evidence: [] };
    await sink.emit({
      attempt_id: bundle.attempt.id,
      local_seq: 0,
      dedup_key: dedupKey(bundle.attempt.id, 0),
      at: new Date().toISOString(),
      type: 'attempt_outcome',
      outcome,
      usage: {
        input_tokens: 80,
        output_tokens: 80,
        cached_input_tokens: 0,
        usd_est: 0,
        requests: 1,
      },
    });
    return outcome;
  }
  async cancel() {}
}

/** A records table, arranged by whatever ordering steps were delivered. */
function arrange(objective: string, steps: readonly StepForm[]) {
  const task = recordTask.parse(JSON.parse(objective.slice(TASK_PREFIX.length)));
  const typed = steps.some((step) => step.form === 'typed_order');
  const text = steps.some((step) => step.form === 'text_order');
  let rows = [...task.rows];
  const value = (item: (typeof rows)[number]): number | string => {
    const raw = item[task.key];
    if (text) return String(raw);
    if (task.type === 'number') return Number(raw);
    if (typed && task.type === 'date') {
      if (task.dateFormat === 'dmy') {
        const [day, month, year] = String(raw).split('/');
        return Date.parse(`${year}-${month}-${day}T00:00:00Z`);
      }
      return Date.parse(String(raw));
    }
    return String(raw);
  };
  // The default handles numbers but leaves unfamiliar date/text tables in their original order.
  if (typed || text || task.type === 'number')
    rows.sort((left, right) => {
      const a = value(left);
      const b = value(right);
      const comparison = a < b ? -1 : a > b ? 1 : 0;
      return task.direction === 'ascending' ? comparison : -comparison;
    });
  for (const step of steps) if (step.form === 'sort') rows = sortRows(rows, step, task.dateFormat);
  return JSON.stringify({ columns: task.columns, rows });
}
