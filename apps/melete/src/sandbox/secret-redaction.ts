/**
 * Keeps a sealed secret out of what a command in the agent's computer printed.
 *
 * A command given a secret has it in its environment, and anything it prints
 * may carry it. Every occurrence becomes `[redacted]` before the output is
 * hashed, previewed, stored or put on a receipt, so the value reaches neither
 * the conversation, the model, nor a row of the database.
 */
import type { JsonValue } from '@melete/contracts';
import { ByteRedactor } from '../egress/redact.ts';

/** The bytes with every occurrence of every value replaced. */
export function redactBytes(bytes: Uint8Array, values: readonly string[]): Uint8Array {
  if (!values.length || !bytes.byteLength) return bytes;
  const redactor = new ByteRedactor(values);
  return new Uint8Array(Buffer.concat([redactor.feed(bytes), redactor.end()]));
}

/** A receipt's detail, or any JSON, with every string in it redacted. */
export function redactJson<T extends JsonValue>(value: T, values: readonly string[]): T {
  if (!values.length) return value;
  const redactor = new ByteRedactor(values);
  const walk = (item: JsonValue): JsonValue => {
    if (typeof item === 'string') return redactor.text(item);
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item).map(([key, inner]) => [redactor.text(key), walk(inner as JsonValue)]),
      );
    return item;
  };
  return walk(value) as T;
}
