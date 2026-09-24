/**
 * Removing a space. The vocabulary is shared so the service, a client and the
 * conformance suite all read the same words for what a removal is doing and
 * how far it has got.
 *
 * A removal is an ordered sweep, not one delete, so its progress is a phase and
 * its outcome is a state. `complete` is reserved: it means a verification pass
 * re-counted every table, path and provider listing and found nothing left.
 */
import { z } from 'zod';
import { ID_PREFIXES, prefixedId, timestamp } from './common.ts';

/**
 * The phases, in the order they run. Each one finishes and is committed before
 * the next begins, so an interrupted removal resumes at a phase boundary and
 * repeats at most one phase.
 */
export const REMOVAL_PHASES = [
  'fence',
  'sessions',
  'journal',
  'sandboxes',
  'browser',
  /**
   * Engine session volumes kept past an attempt, labelled by job. The runtime
   * removes each attempt's home volume when the attempt ends, so today the
   * phase finds none and says so; it is named here in the order it has to run
   * — after the worker that could still write into one, and before the
   * directories that hold them.
   *
   * It clears volumes labelled by job, and only those. The deployment's single
   * `runtime-home` volume is shared by every space and is not one of them.
   */
  'runtime',
  'files',
  'operational',
  'principals',
  'memory',
  'verify',
  'space',
] as const;
export const removalPhase = z.enum(REMOVAL_PHASES);
export type RemovalPhase = z.infer<typeof removalPhase>;

/**
 * `cleaning` is an emptied space that is open again: everything in it has
 * gone, and files that stopped work still held are being removed in the
 * background, named in `counts.paths`, until the removal is `complete`.
 */
export const REMOVAL_STATES = ['pending', 'running', 'blocked', 'cleaning', 'complete'] as const;
export const spaceRemovalState = z.enum(REMOVAL_STATES);
export type SpaceRemovalState = z.infer<typeof spaceRemovalState>;

/**
 * A space of one's own is recreated the moment its account asks for one, so it
 * is emptied rather than removed; every other space is removed outright.
 */
export const REMOVAL_KINDS = ['removed', 'emptied'] as const;
export const spaceRemovalKind = z.enum(REMOVAL_KINDS);
export type SpaceRemovalKind = z.infer<typeof spaceRemovalKind>;

/**
 * Why a phase did no work. `not_applicable` is proven: the thing that phase
 * clears is not present for this space. `capability_absent` is not proven, and
 * a removal carrying one can never be reported as finished.
 */
export const PHASE_OMISSIONS = ['not_applicable', 'capability_absent'] as const;
export const phaseOmission = z.enum(PHASE_OMISSIONS);
export type PhaseOmission = z.infer<typeof phaseOmission>;

/**
 * What the verification pass found. Every number is a count of what is still
 * there, so an all-zero reading with nothing omitted is the only reading that
 * lets a removal finish.
 */
export const removalCounts = z.object({
  /** Rows still keyed to the space, by table name. Absent tables are zero. */
  tables: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /** Paths that still exist, named so a person can see which one is held open. */
  paths: z.array(z.string()).default([]),
  /** Sessions and snapshots a provider still lists for the space. */
  providers: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /** Phases that did no work, and whether that was proven or merely unreachable. */
  omitted: z.partialRecord(removalPhase, phaseOmission).default({}),
  /**
   * What went, which is the opposite question from every field above. Nothing
   * here can stop a removal finishing; it is what the finished account draws on
   * when it says how many signed-in sites or provider snapshots were cleared.
   */
  cleared: z.record(z.string(), z.number().int().nonnegative()).default({}),
});
export type RemovalCounts = z.infer<typeof removalCounts>;

export const EMPTY_COUNTS: RemovalCounts = {
  tables: {},
  paths: [],
  providers: {},
  omitted: {},
  cleared: {},
};

/** True only when the sweep left nothing behind and skipped nothing it could not prove. */
export function removalIsClear(counts: RemovalCounts): boolean {
  return (
    Object.values(counts.tables).every((count) => count === 0) &&
    counts.paths.length === 0 &&
    Object.values(counts.providers).every((count) => count === 0) &&
    Object.values(counts.omitted).every((reason) => reason === 'not_applicable')
  );
}

export const spaceRemoval = z
  .object({
    id: prefixedId('rem'),
    space_id: prefixedId(ID_PREFIXES.space),
    space_name: z.string().min(1),
    kind: spaceRemovalKind,
    state: spaceRemovalState,
    phase: removalPhase,
    counts: removalCounts,
    /** Set only on a blocked removal, and it names the thing that stopped it. */
    blocked_reason: z.string().nullable(),
    started_at: timestamp,
    finished_at: timestamp.nullable(),
  })
  .meta({ id: 'SpaceRemoval' });
export type SpaceRemoval = z.infer<typeof spaceRemoval>;

/** The name has to be typed out, so the wrong space cannot be removed by a stray click. */
export const deleteSpaceRequest = z.object({ confirm_name: z.string().min(1).max(120) });
export type DeleteSpaceRequest = z.infer<typeof deleteSpaceRequest>;

/** What the space holds right now, counted before anything is asked of the person. */
export const removalPreviewCounts = z.object({
  jobs: z.number().int().nonnegative(),
  memory_claims: z.number().int().nonnegative(),
  knowledge_files: z.number().int().nonnegative(),
  artifacts: z.number().int().nonnegative(),
  connections: z.number().int().nonnegative(),
  /** Companies found by scanning the mailbox, and the ledger items quoting its messages. */
  companies: z.number().int().nonnegative(),
  ledger_items: z.number().int().nonnegative(),
  signed_in_sites: z.number().int().nonnegative(),
  sandboxes: z.number().int().nonnegative(),
});
export type RemovalPreviewCounts = z.infer<typeof removalPreviewCounts>;

/** A connection whose key keeps working at the service that issued it. */
export const removalProvider = z.object({
  provider: z.string().min(1),
  label: z.string(),
});
export type RemovalProvider = z.infer<typeof removalProvider>;

/**
 * Everything the confirmation puts in front of a person: what is there, what
 * the removal does not reach, and the name they have to type to go ahead.
 */
export const spaceRemovalPreview = z
  .object({
    space_id: prefixedId(ID_PREFIXES.space),
    name: z.string().min(1),
    kind: spaceRemovalKind,
    counts: removalPreviewCounts,
    providers: z.array(removalProvider),
    /** One line each, in the order a person should read them. */
    stays: z.array(z.string().min(1)),
    /** What the person is agreeing to, in one sentence. */
    confirmation: z.string().min(1),
  })
  .meta({ id: 'SpaceRemovalPreview' });
export type SpaceRemovalPreview = z.infer<typeof spaceRemovalPreview>;

/** The finished account: what went, and what is left for the person to do elsewhere. */
export const spaceRemovalReport = z
  .object({
    removal: spaceRemoval,
    headline: z.string().min(1),
    /** One line per thing that was cleared, written in the past tense. */
    cleared: z.array(z.string().min(1)),
    /** One line per thing the person still has to do at another service. */
    still_yours: z.array(z.string().min(1)),
  })
  .meta({ id: 'SpaceRemovalReport' });
export type SpaceRemovalReport = z.infer<typeof spaceRemovalReport>;
