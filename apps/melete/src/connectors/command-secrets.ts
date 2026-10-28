/**
 * The part of a command in the agent's computer that concerns sealed secrets:
 * which ones it names, opening them for it, and keeping every value the
 * space holds out of the receipt it leaves. `terminal.run` and
 * `process.start` both use it.
 */
import { type JsonValue, type Receipt, SEALED_SECRET_NAME_PATTERN } from '@melete/contracts';
import { redactJson } from '../sandbox/secret-redaction.ts';
import {
  type CommandSecrets,
  MAX_COMMAND_SECRETS,
  SecretRefusal,
  type SpaceSecrets,
} from './space-secrets.ts';

/** The secrets a command may name: sealed in its space, by name only. */
export const SECRETS_SCHEMA = {
  type: 'array',
  maxItems: MAX_COMMAND_SECRETS,
  items: { type: 'string', pattern: SEALED_SECRET_NAME_PATTERN.source },
  description:
    'Names of secrets the person saved in this space, each set as an environment variable for this command only, such as ["API_KEY"] read as $API_KEY. Their values are redacted from the output and never shown to you.',
};

/** The most `$NAME` references the engine's terminal passes on for one command. */
const MAX_SECRET_REFS = 32;

/**
 * What the engine's terminal sets: the `$NAME` references in the command. Only
 * those sealed in the space are given, and any other name is left alone, since
 * most are ordinary variables of the computer's own.
 */
export const SECRET_REFS_SCHEMA = {
  type: 'array',
  maxItems: MAX_SECRET_REFS,
  items: { type: 'string', pattern: SEALED_SECRET_NAME_PATTERN.source },
  description: "Set by the agent's terminal from the command's $NAME references.",
};

const namesIn = (value: unknown, max: number, field: string): string[] => {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > max ||
    !value.every((name) => typeof name === 'string' && SEALED_SECRET_NAME_PATTERN.test(name))
  )
    throw new SecretRefusal(
      `${field} is a list of at most ${max} names such as API_KEY, saved in this space`,
    );
  return [...new Set(value as string[])];
};

/** The secret names a payload carries; anything that is not a list of names is refused. */
export function secretNamesOf(payload: Record<string, unknown>): string[] {
  return namesIn(payload.secrets, MAX_COMMAND_SECRETS, 'secrets');
}

/** The `$NAME` references the engine's terminal found in a command. */
export function secretRefsOf(payload: Record<string, unknown>): string[] {
  return namesIn(payload.secret_refs, MAX_SECRET_REFS, 'secret_refs');
}

const NO_SECRETS: CommandSecrets = { env: {}, used: [], values: [] };

/**
 * The secrets a command named, opened for it, and every value the space keeps
 * for commands, so that what it prints is redacted for all of them. A name
 * this space has not sealed is refused before anything runs.
 */
export async function commandSecrets(
  secrets: SpaceSecrets | undefined,
  spaceId: string,
  payload: { secrets?: string[]; secret_refs?: string[] },
): Promise<CommandSecrets> {
  const named = payload.secrets ?? [];
  if (!secrets) {
    if (named.length) throw new SecretRefusal('Secrets cannot be used on this installation.');
    return NO_SECRETS;
  }
  const given = await secrets.forCommand(spaceId, named, payload.secret_refs ?? []);
  const kept = await secrets.valuesOf(spaceId);
  return { ...given, values: [...new Set([...given.values, ...kept])] };
}

/** A receipt with the secrets' values redacted, naming the ones the command was given. */
export function sealedReceipt(receipt: Receipt, given: CommandSecrets): Receipt {
  if (!given.values.length && !given.used.length) return receipt;
  return {
    ...receipt,
    detail: {
      ...(redactJson(receipt.detail as JsonValue, given.values) as Record<string, JsonValue>),
      ...(given.used.length ? { secrets_used: given.used } : {}),
    } as Receipt['detail'],
  };
}

/** The same for a command's outcome, whatever it was. */
export function sealedOutcome<T extends { outcome: string; receipt?: Receipt; reason?: string }>(
  outcome: T,
  given: CommandSecrets,
): T {
  if (!given.values.length && !given.used.length) return outcome;
  return {
    ...outcome,
    ...(outcome.receipt ? { receipt: sealedReceipt(outcome.receipt, given) } : {}),
    ...(outcome.reason ? { reason: redactJson(outcome.reason, given.values) } : {}),
  };
}
