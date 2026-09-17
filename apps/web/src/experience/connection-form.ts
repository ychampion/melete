/**
 * Turning what a person typed into the body of `POST /connections`, knowing
 * nothing about any kind of connection. The descriptor from
 * `GET /connection-kinds` says which fields exist, where each value goes in the
 * request and which grants may be chosen; this file only follows it.
 */
import type { ConnectionItemField, ConnectionKind } from './types.ts';

export type FieldValue = string | boolean;
export type RowValues = Record<string, FieldValue>;
export type FormValues = {
  label: string;
  fields: Record<string, FieldValue>;
  lists: Record<string, RowValues[]>;
  scopes: Record<string, boolean>;
};

const initial = (field: ConnectionItemField): FieldValue =>
  field.input === 'checkbox'
    ? field.default === true
    : field.default === undefined
      ? field.input === 'select'
        ? (field.options?.[0]?.value ?? '')
        : ''
      : String(field.default);

export const emptyRow = (fields: readonly ConnectionItemField[]): RowValues =>
  Object.fromEntries(fields.map((field) => [field.path, initial(field)]));

export function emptyForm(kind: ConnectionKind): FormValues {
  const fields: FormValues['fields'] = {};
  const lists: FormValues['lists'] = {};
  for (const field of kind.fields) {
    if (field.input === 'list') lists[field.path] = [emptyRow(field.item_fields ?? [])];
    else fields[field.path] = initial({ ...field, input: field.input });
  }
  return {
    label: kind.title,
    fields,
    lists,
    scopes: Object.fromEntries(kind.scopes.map((scope) => [scope.scope, scope.default])),
  };
}

function put(target: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split('.');
  let at = target;
  for (const key of keys.slice(0, -1)) {
    const next = at[key];
    if (typeof next !== 'object' || next === null) at[key] = {};
    at = at[key] as Record<string, unknown>;
  }
  const last = keys.at(-1);
  if (last) at[last] = value;
}

/** Undefined means "leave it out": an empty optional field is absent, not an empty string. */
function typed(field: ConnectionItemField, value: FieldValue | undefined): unknown {
  if (field.input === 'checkbox') return value === true;
  const text = typeof value === 'string' ? value.trim() : '';
  if (field.input === 'string_list') {
    const items = text
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length || field.required ? items : undefined;
  }
  if (!text) return undefined;
  if (field.input === 'number') return Number(text);
  // A secret is sent exactly as typed; trimming a password would change it.
  return field.secret && typeof value === 'string' ? value : text;
}

/** The first thing still missing, in the field's own words, or null when the form can be sent. */
export function missing(kind: ConnectionKind, values: FormValues): string | null {
  if (!values.label.trim()) return 'Give the connection a name.';
  for (const field of kind.fields) {
    if (field.input === 'list') {
      const rows = values.lists[field.path] ?? [];
      if (field.required && rows.length === 0) return `Add at least one row under ${field.label}.`;
      for (const row of rows)
        for (const item of field.item_fields ?? [])
          if (item.required && typed(item, row[item.path]) === undefined)
            return `${field.label}: ${item.label} is needed.`;
    } else if (
      field.required &&
      typed({ ...field, input: field.input }, values.fields[field.path]) === undefined
    )
      return `${field.label} is needed.`;
  }
  if (kind.scopes.length && !kind.scopes.some((scope) => values.scopes[scope.scope]))
    return 'Choose at least one thing this connection may do.';
  return null;
}

export function requestBody(kind: ConnectionKind, values: FormValues): Record<string, unknown> {
  const body: Record<string, unknown> = { label: values.label.trim() };
  for (const fixed of kind.fixed) put(body, fixed.path, fixed.value);
  for (const field of kind.fields) {
    if (field.input === 'list') {
      const rows = (values.lists[field.path] ?? []).map((row) => {
        const entry: Record<string, unknown> = {};
        for (const item of field.item_fields ?? []) {
          const value = typed(item, row[item.path]);
          if (value !== undefined) put(entry, item.path, value);
        }
        return entry;
      });
      put(body, field.path, rows);
      continue;
    }
    const value = typed({ ...field, input: field.input }, values.fields[field.path]);
    if (value !== undefined) put(body, field.path, value);
  }
  if (kind.scopes.length)
    body.scopes = kind.scopes
      .filter((scope) => values.scopes[scope.scope])
      .map((scope) => scope.scope);
  return body;
}
