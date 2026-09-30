/**
 * Storing and reading problem reports. The routes decide who may ask; this
 * module is also what the command-line reader uses, with no session at all.
 */
import {
  type FeedbackContext,
  type FeedbackReport,
  type FeedbackStatus,
  feedbackReport,
  redactText,
  redactUrl,
} from '@melete/contracts';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { owner, principal } from '../db/schema.ts';
import { normalizeFeedbackId, withFreshFeedbackId } from './ids.ts';
import { feedback } from './schema.ts';

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (('code' in error && error.code === '23505') ||
    ('cause' in error && isUniqueViolation((error as { cause: unknown }).cause)));

/** Redact what the page sent, whether or not the page already did. */
export function sanitizeContext(context: FeedbackContext | undefined): FeedbackContext {
  if (!context) return {};
  return {
    ...context,
    ...(context.route !== undefined ? { route: redactUrl(context.route) } : {}),
    ...(context.user_agent !== undefined
      ? { user_agent: redactText(context.user_agent, 500) }
      : {}),
    ...(context.console_errors
      ? {
          console_errors: context.console_errors.map((entry) => ({
            at: entry.at,
            message: redactText(entry.message),
          })),
        }
      : {}),
    ...(context.failed_requests
      ? {
          failed_requests: context.failed_requests.map((entry) => ({
            ...entry,
            url: redactUrl(entry.url),
          })),
        }
      : {}),
  };
}

/** The first line of the message, shortened for a list row. */
export function summarize(message: string, max = 120): string {
  const line = message.trim().split(/\r?\n/)[0]?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

type Row = typeof feedback.$inferSelect;

function toReport(row: Row, email: string | null): FeedbackReport {
  return feedbackReport.parse({
    id: row.id,
    status: row.status,
    message: row.message,
    summary: summarize(row.message),
    route: row.route,
    app_version: row.appVersion,
    context: row.context,
    reporter: { principal_id: row.principalId, email },
    note: row.note,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
}

/** Who is asking: the installation, and a person whose own reports are all they may see. */
export type FeedbackScope = { installationId: string; onlyFrom?: string };

export class FeedbackStore {
  constructor(private readonly db: Database) {}

  /** The installation's id, which is its setup owner's; null before setup. */
  async installation(): Promise<string | null> {
    const [row] = await this.db.select({ id: owner.id }).from(owner).limit(1);
    return row?.id ?? null;
  }

  async create(input: {
    installationId: string;
    principalId: string;
    message: string;
    context: FeedbackContext | undefined;
    appVersion: string;
  }): Promise<FeedbackReport> {
    const context = sanitizeContext(input.context);
    const row = await withFreshFeedbackId(async (id) => {
      try {
        const [inserted] = await this.db
          .insert(feedback)
          .values({
            id,
            installationId: input.installationId,
            principalId: input.principalId,
            message: input.message,
            route: context.route ?? null,
            appVersion: input.appVersion,
            context,
          })
          .returning();
        return inserted ?? false;
      } catch (error) {
        if (isUniqueViolation(error)) return false;
        throw error;
      }
    });
    return this.read(row);
  }

  async list(scope: FeedbackScope, status?: FeedbackStatus): Promise<FeedbackReport[]> {
    const rows = await this.db
      .select({ row: feedback, email: principal.email })
      .from(feedback)
      .leftJoin(principal, eq(principal.id, feedback.principalId))
      .where(and(...this.within(scope), ...(status ? [eq(feedback.status, status)] : [])))
      .orderBy(desc(feedback.createdAt), desc(feedback.id))
      .limit(500);
    return rows.map(({ row, email }) => toReport(row, email));
  }

  async get(scope: FeedbackScope, id: string): Promise<FeedbackReport | null> {
    const [found] = await this.db
      .select({ row: feedback, email: principal.email })
      .from(feedback)
      .leftJoin(principal, eq(principal.id, feedback.principalId))
      .where(and(eq(feedback.id, normalizeFeedbackId(id)), ...this.within(scope)))
      .limit(1);
    return found ? toReport(found.row, found.email) : null;
  }

  async update(
    scope: FeedbackScope,
    id: string,
    change: { status: FeedbackStatus; note?: string | null },
  ): Promise<FeedbackReport | null> {
    const [row] = await this.db
      .update(feedback)
      .set({
        status: change.status,
        ...(change.note !== undefined ? { note: change.note || null } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(feedback.id, normalizeFeedbackId(id)), ...this.within(scope)))
      .returning();
    return row ? this.read(row) : null;
  }

  private within(scope: FeedbackScope): SQL[] {
    return [
      eq(feedback.installationId, scope.installationId),
      ...(scope.onlyFrom ? [eq(feedback.principalId, scope.onlyFrom)] : []),
    ];
  }

  private async read(row: Row): Promise<FeedbackReport> {
    const [person] = row.principalId
      ? await this.db
          .select({ email: principal.email })
          .from(principal)
          .where(eq(principal.id, row.principalId))
      : [];
    return toReport(row, person?.email ?? null);
  }
}
