import { createHash } from 'node:crypto';
import {
  createJobRequest,
  inputDigest,
  type JsonValue,
  jsonValue,
  postMessageRequest,
  type SubmissionReceipt,
  submissionId,
  submissionReceipt,
} from '@melete/contracts';
import { eq } from 'drizzle-orm';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ServiceError } from '../api/errors.ts';
import { acceptanceJournal, event, job, submission } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { newId } from '../ids.ts';
import type { JobRow, JobService } from './service.ts';

/** Canonical input preserves text bytes; action-specific email normalization does not apply. */
export function canonicalSubmissionInput(value: JsonValue): string {
  const ordered = (input: JsonValue): JsonValue => {
    if (Array.isArray(input)) return input.map(ordered);
    if (input && typeof input === 'object')
      return Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((key) => [key, ordered(input[key] ?? null)]),
      );
    return input;
  };
  return JSON.stringify(ordered(value));
}
const hash = (value: JsonValue) =>
  createHash('sha256').update(canonicalSubmissionInput(value)).digest('hex');
export function submissionDigest(kind: 'create' | 'input', input: unknown, jobId?: string): string {
  return hash({ kind, job_id: jobId ?? null, input: jsonValue.parse(input) });
}
const unknown = (id: string, digest: string | null = null): SubmissionReceipt => ({
  submission_id: id,
  input_digest: digest,
  job_id: null,
  job_revision: null,
  event_cursor: null,
  state: 'unknown_durability',
});
export type SubmissionResult = {
  receipt: SubmissionReceipt;
  job: JobRow | null;
  status: ContentfulStatusCode;
  error?: { code: string; message: string };
  replayed: boolean;
};
export type SubmissionFaults = {
  afterAdmissionBeforeResponse?: (receipt: SubmissionReceipt) => void | Promise<void>;
};

export class SubmissionService {
  onAccepted?: (tx: Transaction, receipt: SubmissionReceipt, row: JobRow) => Promise<void>;
  constructor(
    readonly jobs: JobService,
    readonly faults: SubmissionFaults = {},
  ) {}

  private async read(tx: Transaction, id: string) {
    const [saved] = await tx.select().from(submission).where(eq(submission.submissionId, id));
    const [history] = await tx
      .select()
      .from(acceptanceJournal)
      .where(eq(acceptanceJournal.submissionId, id));
    const [marker] = await tx
      .select()
      .from(event)
      .where(eq(event.dedupKey, `submission:${id}`));
    const parsed = submissionReceipt.safeParse(history?.receipt);
    let current: JobRow | null = null;
    const valid =
      parsed.success &&
      parsed.data.submission_id === id &&
      history?.receiptHash === hash(parsed.data);
    const savedDigest = inputDigest.safeParse(saved?.inputDigest);
    const markerDigest = inputDigest.safeParse(
      (marker?.payload as { input_digest?: unknown } | undefined)?.input_digest,
    );
    const knownDigest = valid
      ? parsed.data.input_digest
      : savedDigest.success
        ? savedDigest.data
        : markerDigest.success
          ? markerDigest.data
          : null;
    let receipt = unknown(id, knownDigest);
    if (saved && valid) {
      const stored = submissionReceipt.safeParse({
        submission_id: saved.submissionId,
        input_digest: saved.inputDigest,
        job_id: saved.jobId,
        job_revision: saved.jobRevision,
        event_cursor: saved.eventCursor,
        state: saved.state,
      });
      if (
        stored.success &&
        canonicalSubmissionInput(stored.data) === canonicalSubmissionInput(parsed.data) &&
        history?.jobId === stored.data.job_id
      ) {
        receipt = stored.data;
        if (receipt.state === 'accepted') {
          if (receipt.job_id !== null) {
            const [row] = await tx.select().from(job).where(eq(job.id, receipt.job_id));
            current = row ?? null;
          }
          if (
            !current ||
            receipt.job_revision === null ||
            current.revision < receipt.job_revision ||
            receipt.event_cursor === null
          )
            receipt = unknown(id, saved.inputDigest);
        }
      }
    }
    return {
      saved,
      history,
      marker,
      knownDigest,
      receipt,
      job: receipt.state === 'accepted' ? current : null,
    };
  }

  private async storeUncertainty(tx: Transaction, id: string, digest: string) {
    await tx
      .insert(submission)
      .values({
        submissionId: id,
        inputDigest: digest,
        state: 'unknown_durability',
        httpStatus: 503,
        errorCode: 'unknown_durability',
      })
      .onConflictDoUpdate({
        target: submission.submissionId,
        set: { state: 'unknown_durability', httpStatus: 503, errorCode: 'unknown_durability' },
      });
  }

  get(id: string): Promise<SubmissionReceipt> {
    submissionId.parse(id);
    return this.jobs.transaction(async (tx) => {
      const previous = await this.read(tx, id);
      if (
        previous.receipt.state === 'unknown_durability' &&
        previous.knownDigest &&
        (previous.saved || previous.history || previous.marker)
      )
        await this.storeUncertainty(tx, id, previous.knownDigest);
      return previous.receipt;
    });
  }

  create(input: unknown, id?: string) {
    return this.submit('create', input, id);
  }
  input(jobId: string, input: unknown, id?: string) {
    return this.submit('input', input, id, jobId);
  }

  private async submit(
    kind: 'create' | 'input',
    raw: unknown,
    suppliedId?: string,
    jobId?: string,
  ): Promise<SubmissionResult> {
    const id = submissionId.parse(suppliedId ?? newId('job').slice(4));
    const digest = submissionDigest(kind, raw, jobId);
    const result = await this.jobs.transaction(async (tx): Promise<SubmissionResult> => {
      const previous = await this.read(tx, id);
      if (previous.saved || previous.history || previous.marker) {
        const knownDigest = previous.knownDigest;
        if (knownDigest !== null && knownDigest !== digest) {
          const key = `submission:${id}:conflict:${digest}`;
          let rejected = await appendEvent(tx, {
            type: 'notice',
            payload: {
              kind: 'submission_rejected',
              submission_id: id,
              input_digest: digest,
              reason: 'submission_conflict',
            },
            dedupKey: key,
          });
          if (!rejected) [rejected] = await tx.select().from(event).where(eq(event.dedupKey, key));
          return {
            receipt: {
              ...unknown(id, digest),
              state: 'rejected',
              event_cursor: rejected?.seq ?? null,
            },
            job: null,
            status: 409,
            error: {
              code: 'submission_conflict',
              message: 'This submission ID belongs to a different input.',
            },
            replayed: true,
          };
        }
        if (previous.receipt.state === 'unknown_durability') {
          await this.storeUncertainty(tx, id, digest);
          return {
            receipt: { ...previous.receipt, input_digest: digest },
            job: null,
            status: 503,
            error: {
              code: 'unknown_durability',
              message:
                'The acceptance history cannot be verified. Reusing this ID will not admit new work.',
            },
            replayed: true,
          };
        }
        return {
          receipt: previous.receipt,
          job: previous.job,
          status: (previous.saved?.httpStatus ?? 200) as ContentfulStatusCode,
          ...(previous.saved?.errorCode
            ? {
                error: {
                  code: previous.saved.errorCode,
                  message: previous.saved.errorMessage ?? 'Submission rejected.',
                },
              }
            : {}),
          replayed: true,
        };
      }

      let current: JobRow | null = null;
      let rejection: ServiceError | undefined;
      const parsed =
        kind === 'create' ? createJobRequest.safeParse(raw) : postMessageRequest.safeParse(raw);
      if (!parsed.success)
        rejection = new ServiceError('invalid_request', 'Submission data is invalid.', 400);
      else {
        try {
          // The savepoint keeps a rejected admission from leaving partial job writes.
          current = await tx.transaction((admission) =>
            kind === 'create'
              ? this.jobs.createInTransaction(admission, createJobRequest.parse(parsed.data))
              : this.jobs.inputInTransaction(
                  admission,
                  jobId ?? '',
                  postMessageRequest.parse(parsed.data).text,
                ),
          );
        } catch (error) {
          if (!(error instanceof ServiceError)) throw error;
          rejection = error;
        }
      }
      const accepted = current !== null && rejection === undefined;
      const recorded = await appendEvent(tx, {
        jobId: current?.id,
        type: 'notice',
        payload: {
          kind: accepted ? 'submission_accepted' : 'submission_rejected',
          submission_id: id,
          input_digest: digest,
          job_revision: current?.revision ?? null,
          reason: rejection?.code ?? null,
        },
        dedupKey: `submission:${id}`,
      });
      if (!recorded)
        throw new Error('An admission marker already exists without its receipt history');
      const receipt: SubmissionReceipt = {
        submission_id: id,
        input_digest: digest,
        job_id: current?.id ?? null,
        job_revision: current?.revision ?? null,
        event_cursor: recorded.seq,
        state: accepted ? 'accepted' : 'rejected',
      };
      const status = rejection?.status ?? (kind === 'create' ? 201 : 200);
      await tx.insert(submission).values({
        submissionId: id,
        inputDigest: digest,
        jobId: receipt.job_id,
        jobRevision: receipt.job_revision,
        eventCursor: receipt.event_cursor,
        state: receipt.state,
        httpStatus: status,
        errorCode: rejection?.code,
        errorMessage: rejection?.message,
      });
      await tx
        .insert(acceptanceJournal)
        .values({ submissionId: id, jobId: receipt.job_id, receipt, receiptHash: hash(receipt) });
      if (accepted && current) await this.onAccepted?.(tx, receipt, current);
      return {
        receipt,
        job: current,
        status,
        ...(rejection ? { error: { code: rejection.code, message: rejection.message } } : {}),
        replayed: false,
      };
    });
    if (!result.replayed && result.receipt.state === 'accepted')
      await this.faults.afterAdmissionBeforeResponse?.(result.receipt);
    return result;
  }
}
