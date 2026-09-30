/**
 * Problem reports from inside the app.
 *
 * A person who hits something wrong says what went wrong in a sentence; the
 * page adds what it knows about itself (the route, the browser, the screen,
 * recent errors and failed requests) so whoever runs the installation can find
 * the cause without a second conversation. Each report gets a short id that is
 * easy to read aloud and paste into a request to fix it.
 */
import { z } from 'zod';
import { ID_PREFIXES, prefixedId, timestamp } from './common.ts';

/**
 * The characters a report id is written in: digits and capitals without the
 * ones people misread or mishear (0 and O, 1, I and L, U and V).
 */
export const FEEDBACK_ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTWXYZ';

/** `FB-` and four characters, growing only if four are ever used up. */
export const feedbackId = z
  .string()
  .regex(/^FB-[23456789ABCDEFGHJKMNPQRSTWXYZ]{4,8}$/, 'must look like FB-7K3Q')
  .meta({ description: 'A short report id, such as FB-7K3Q', example: 'FB-7K3Q' });
export type FeedbackId = z.infer<typeof feedbackId>;

export const feedbackStatus = z
  .enum(['open', 'fixing', 'fixed', 'wontfix'])
  .meta({ id: 'FeedbackStatus' });
export type FeedbackStatus = z.infer<typeof feedbackStatus>;

/** The most of each kind of recent trouble a report carries. */
export const FEEDBACK_RECENT_LIMIT = 20;

export const feedbackConsoleError = z.object({
  at: timestamp,
  message: z.string().max(1000),
});

export const feedbackFailedRequest = z.object({
  at: timestamp,
  method: z.string().max(10),
  /** The address with credentials, emails and sensitive query values replaced. */
  url: z.string().max(500),
  /** Null when the request never got an answer. */
  status: z.number().int().min(0).max(999).nullable(),
  /** The error code the service answered with, if it gave one. */
  code: z.string().max(80).nullable(),
});

/** What the page says about itself. Every field is optional; the page sends what it has. */
export const feedbackContext = z
  .object({
    route: z.string().max(500).optional(),
    user_agent: z.string().max(500).optional(),
    language: z.string().max(35).optional(),
    time_zone: z.string().max(64).optional(),
    viewport: z
      .object({
        width: z.number().int().min(0).max(100_000),
        height: z.number().int().min(0).max(100_000),
        pixel_ratio: z.number().min(0).max(16).optional(),
      })
      .optional(),
    color_scheme: z.enum(['light', 'dark']).optional(),
    console_errors: z.array(feedbackConsoleError).max(FEEDBACK_RECENT_LIMIT).optional(),
    failed_requests: z.array(feedbackFailedRequest).max(FEEDBACK_RECENT_LIMIT).optional(),
  })
  .meta({ id: 'FeedbackContext' });
export type FeedbackContext = z.infer<typeof feedbackContext>;

export const createFeedbackRequest = z.object({
  message: z.string().trim().min(1).max(5000),
  /** Left out when the person chose not to include details about the page. */
  context: feedbackContext.optional(),
});
export type CreateFeedbackRequest = z.infer<typeof createFeedbackRequest>;

export const updateFeedbackRequest = z.object({
  status: feedbackStatus,
  /** A line for the person who reported it, or for whoever picks it up next. */
  note: z.string().trim().max(2000).nullable().optional(),
});
export type UpdateFeedbackRequest = z.infer<typeof updateFeedbackRequest>;

export const feedbackReport = z
  .object({
    id: feedbackId,
    status: feedbackStatus,
    message: z.string(),
    /** The first line of the message, shortened for a list. */
    summary: z.string(),
    route: z.string().nullable(),
    /** The service version that took the report. */
    app_version: z.string(),
    context: feedbackContext,
    reporter: z.object({
      principal_id: prefixedId(ID_PREFIXES.owner).nullable(),
      email: z.string().nullable(),
    }),
    note: z.string().nullable(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .meta({ id: 'FeedbackReport' });
export type FeedbackReport = z.infer<typeof feedbackReport>;

export const feedbackResponse = z.object({ report: feedbackReport });

export const feedbackListQuery = z.object({ status: feedbackStatus.optional() });

export const feedbackListResponse = z.object({
  reports: z.array(feedbackReport),
  /**
   * True for the person who runs the installation: the list is everyone's and
   * statuses can be changed. Anyone else sees only their own reports.
   */
  can_manage: z.boolean(),
});
export type FeedbackListResponse = z.infer<typeof feedbackListResponse>;
