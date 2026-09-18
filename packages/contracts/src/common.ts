/**
 * Primitives shared by every Melete contract: identifiers, timestamps, and the
 * `Result` type used by pure decision functions such as the job state machine.
 */
import { z } from 'zod';

/** Crockford base32, 26 characters, as produced by `ulid()`. */
export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export const ulid = z
  .string()
  .regex(ULID_PATTERN, 'must be a ULID (26 Crockford base32 characters)');

/**
 * A prefixed identifier: `job_01J...`. The prefix names the entity so an id
 * pasted into a bug report is self-describing, and a knowledge record keeps a
 * stable id across retitling.
 */
export const prefixedId = (prefix: string) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}_[0-7][0-9A-HJKMNP-TV-Z]{25}$`), `must be a ${prefix}_ ULID`);

export const ID_PREFIXES = {
  owner: 'own',
  space: 'sp',
  connection: 'conn',
  secret: 'sec',
  job: 'job',
  attempt: 'att',
  action: 'act',
  approval: 'apr',
  artifact: 'art',
  knowledge: 'k',
  trigger: 'trg',
  ledger: 'led',
  skill: 'skl',
  question: 'qst',
  repair_candidate: 'rpc',
  company: 'co',
  /** An item on a company's ledger. `ledger` above is the budget ledger. */
  ledger_item: 'li',
  /** One run of the inbox scan that builds the company map. */
  scan: 'scn',
  /** A stored message the ledger's evidence spans are checked against. */
  company_message: 'msg',
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

/** ISO-8601 instant, always UTC in storage. */
export const timestamp = z.iso.datetime({ offset: true });
/** Calendar date with no time component (`valid_from`, `valid_until`). */
export const dateOnly = z.iso.date();

export const jsonPrimitive = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type JsonPrimitive = z.infer<typeof jsonPrimitive>;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([jsonPrimitive, z.array(jsonValue), z.record(z.string(), jsonValue)]),
);
export const jsonObject = z.record(z.string(), jsonValue);
export type JsonObject = Record<string, JsonValue>;

/** A JSON Schema document, carried opaquely (connector manifests supply their own). */
export const jsonSchema = z.record(z.string(), z.unknown());
export type JsonSchema = Record<string, unknown>;

export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
/** Every pure decision function in Melete returns one of these; none of them throw. */
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

/** Unwrap or throw. Only for tests and start-up code, never on a request path. */
export const unwrap = <T, E>(r: Result<T, E>): T => {
  if (r.ok) return r.value;
  throw new Error(`unwrap on error result: ${JSON.stringify(r.error)}`);
};

export const SCHEMA_VERSION = 1;
