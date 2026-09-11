import {
  type AttemptBundle,
  dedupKey,
  type EventSink,
  type RuntimeAdapter,
} from '@melete/contracts';
import { recordTask, TASK_PREFIX } from './records.ts';

/**
 * A deterministic provider fixture: it transforms arbitrary inputs, sees delivered skill text,
 * and has no expected answers, validation templates, or sealed tasks in its implementation.
 */
export class ScriptedRecordRuntime implements RuntimeAdapter {
  readonly observed: AttemptBundle[] = [];
  async capabilities() {
    return { version: 'scripted-records/1', tools: true, streaming: false, interrupt: true };
  }
  async start(bundle: AttemptBundle, sink: EventSink, signal: AbortSignal) {
    signal.throwIfAborted();
    this.observed.push(structuredClone(bundle));
    if (!bundle.job.objective.startsWith(TASK_PREFIX)) throw new Error('record_task_required');
    const task = recordTask.parse(JSON.parse(bundle.job.objective.slice(TASK_PREFIX.length)));
    const correction = bundle.inputs.new_user_messages.some((message) =>
      /\b(date|numeric|typed|chronological|chronologically)\b/i.test(message.content),
    );
    const typed =
      correction ||
      bundle.skills.some((skill) => skill.body.includes('using the declared column type'));
    const text = bundle.skills.some((skill) =>
      skill.body.includes('comparing the selected values as text'),
    );
    const rows = [...task.rows];
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
    // The baseline handles numbers but leaves unfamiliar date/text tables in their original order.
    if (typed || text || task.type === 'number')
      rows.sort((left, right) => {
        const a = value(left);
        const b = value(right);
        const comparison = a < b ? -1 : a > b ? 1 : 0;
        return task.direction === 'ascending' ? comparison : -comparison;
      });
    const outcome = {
      kind: 'completed' as const,
      summary: JSON.stringify({ columns: task.columns, rows }),
      evidence: [],
    };
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
