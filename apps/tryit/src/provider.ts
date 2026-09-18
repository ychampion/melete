/**
 * The one seam between the page and a model. Everything above this line is the
 * same whether the case file came from the live API or from the scripted
 * provider the tests use, which is what lets the gates and the page be proved
 * without a key and without the network.
 */
import type { SearchSource } from './validate.ts';

export type ProviderRun = {
  /** The person's own text, already inside the cap. */
  pasted: string;
  /** Today in YYYY-MM-DD, so the ladder's dates mean something. */
  today: string;
  signal: AbortSignal;
};

export type ProviderResult = {
  /** Whatever the model returned, still unchecked. */
  json: unknown;
  /** Every page the search really returned. The only links that may be shown. */
  sources: SearchSource[];
  /** How many searches were run. Recorded as a number, never with its content. */
  searches: number;
};

export type FailureCode = 'timeout' | 'upstream' | 'refused' | 'malformed';

/**
 * A failure with an outcome code the page already has words for, and one thing
 * the caller cannot work out for itself: whether the model was paid for before
 * this went wrong.
 *
 * It matters because the day's budget is handed back on a failure, and handing
 * back a turn that has already cost tokens is not a budget at all. Only a
 * failure that reached nobody is free — the connection never opened, or the
 * API answered with a status instead of a completion.
 *
 * So the default is `true`, and a caller has to state that a failure was free.
 * A provider that forgets this flag costs a visitor a turn; a provider that
 * forgot it the other way round would hand the owner's key to anyone able to
 * provoke an error on demand. Only one of those two mistakes is survivable.
 */
export class ProviderError extends Error {
  readonly code: FailureCode;
  readonly billed: boolean;
  constructor(code: FailureCode, message: string, billed = true) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.billed = billed;
  }
}

export interface CaseFileProvider {
  /** Recorded in the timing line so a log says which path ran. */
  readonly name: string;
  run(run: ProviderRun): Promise<ProviderResult>;
}
