import { randomInt } from 'node:crypto';
import { FEEDBACK_ID_ALPHABET } from '@melete/contracts';

/** Four characters give about 700,000 ids; a collision is retried, then a longer id is used. */
export const FEEDBACK_ID_LENGTH = 4;
export const FEEDBACK_ID_MAX_LENGTH = 8;

/** `FB-` and `length` characters from the read-aloud alphabet, chosen uniformly. */
export function newFeedbackId(
  length = FEEDBACK_ID_LENGTH,
  pick: (size: number) => number = randomInt,
): string {
  let out = 'FB-';
  for (let i = 0; i < length; i++) out += FEEDBACK_ID_ALPHABET[pick(FEEDBACK_ID_ALPHABET.length)];
  return out;
}

/** Ids are written in capitals, but a person may type or say them any way. */
export function normalizeFeedbackId(value: string): string {
  const upper = value.trim().toUpperCase();
  return upper.startsWith('FB-') ? upper : `FB-${upper.replace(/^FB/, '')}`;
}

/**
 * Take ids until `insert` accepts one. `insert` answers false when the id is
 * already used. A few tries at the short length, then one character more, so
 * ids stay short while there is room and never stop being issued.
 */
export async function withFreshFeedbackId<T>(
  insert: (id: string) => Promise<T | false>,
  generate: (length: number) => string = newFeedbackId,
): Promise<T> {
  for (let length = FEEDBACK_ID_LENGTH; length <= FEEDBACK_ID_MAX_LENGTH; length++) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const stored = await insert(generate(length));
      if (stored !== false) return stored;
    }
  }
  throw new Error('No free feedback id was found.');
}
