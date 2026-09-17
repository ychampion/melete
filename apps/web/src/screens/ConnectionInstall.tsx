/**
 * Adding a connection. Nothing here knows what mail, a calendar or an MCP
 * server needs: the service says which kinds exist and which fields each one
 * takes, and this draws exactly that. A new kind on the service is a new form
 * here without a change to this file.
 */
import { useState } from 'react';
import { Badge, Button, Checkbox, Field, Input, Select } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import {
  emptyForm,
  emptyRow,
  type FieldValue,
  type FormValues,
  missing,
  requestBody,
} from '../experience/connection-form.ts';
import { useLoad } from '../experience/hooks.ts';
import type { ConnectionItemField, ConnectionKind } from '../experience/types.ts';
import { toast } from '../shell/Shell.tsx';

const INPUT_TYPE: Partial<Record<ConnectionItemField['input'], string>> = {
  email: 'email',
  url: 'url',
  number: 'number',
  password: 'password',
};

function Control({
  field,
  value,
  onChange,
}: {
  field: ConnectionItemField;
  value: FieldValue;
  onChange: (next: FieldValue) => void;
}) {
  const label = field.required ? field.label : `${field.label} (optional)`;
  if (field.input === 'checkbox')
    return (
      <div className="col" style={{ gap: 4 }}>
        <span className="row" style={{ gap: 8, fontSize: 13, color: 'var(--heading)' }}>
          <Checkbox checked={value === true} onChange={onChange} label={field.label} />
          {field.label}
        </span>
        {field.help ? (
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{field.help}</span>
        ) : null}
      </div>
    );
  if (field.input === 'select')
    return (
      <Field label={label} hint={field.help}>
        <Select
          label={field.label}
          value={String(value)}
          onChange={onChange}
          options={field.options ?? []}
        />
      </Field>
    );
  return (
    <Field
      label={label}
      hint={
        field.input === 'string_list' ? (field.help ?? 'Separate entries with commas.') : field.help
      }
    >
      <Input
        // What the service seals is masked whatever kind of value it holds, so
        // a feed address kept like a password is typed like one.
        type={field.secret ? 'password' : (INPUT_TYPE[field.input] ?? 'text')}
        value={String(value)}
        placeholder={field.placeholder}
        // A secret is never offered back by the browser's own form memory.
        autoComplete={field.secret ? 'new-password' : 'off'}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

export function KindForm({ kind, onDone }: { kind: ConnectionKind; onDone: () => void }) {
  const [values, setValues] = useState<FormValues>(() => emptyForm(kind));
  const [sending, setSending] = useState(false);
  const gap = missing(kind, values);
  const setField = (path: string, next: FieldValue) =>
    setValues((current) => ({ ...current, fields: { ...current.fields, [path]: next } }));
  const setRows = (path: string, change: (rows: FormValues['lists'][string]) => typeof rows) =>
    setValues((current) => ({
      ...current,
      lists: { ...current.lists, [path]: change(current.lists[path] ?? []) },
    }));

  const submit = () => {
    if (gap) return;
    setSending(true);
    void adapter
      .installConnection(requestBody(kind, values))
      .then((result) => {
        if (result.data === null) {
          toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t add that' });
          return;
        }
        const check = result.data.check;
        if (check && check.status === 'failing')
          toast({
            kind: 'err',
            title: `${values.label} was saved but is not working`,
            sub: check.detail,
          });
        else toast({ kind: 'ok', title: `${values.label} is connected` });
        onDone();
      })
      .finally(() => setSending(false));
  };

  return (
    <form
      className="col card-12"
      style={{ gap: 14, padding: 16 }}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="col" style={{ gap: 4 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--heading)' }}>{kind.title}</span>
        <span style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 560 }}>
          {kind.description}
        </span>
      </div>
      <Field label="Name">
        <Input
          value={values.label}
          maxLength={120}
          onChange={(event) => setValues((current) => ({ ...current, label: event.target.value }))}
        />
      </Field>
      {kind.fields.map((field) =>
        field.input === 'list' ? (
          <fieldset key={field.path} className="col field-group" style={{ gap: 10 }}>
            <legend style={{ fontSize: 13, fontWeight: 500, color: 'var(--heading)' }}>
              {field.label}
            </legend>
            {(values.lists[field.path] ?? []).map((row, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity beyond their position
                key={index}
                className="col"
                style={{ gap: 10, padding: 12, border: '1px solid var(--line)', borderRadius: 12 }}
              >
                {(field.item_fields ?? []).map((item) => (
                  <Control
                    key={item.path}
                    field={item}
                    value={row[item.path] ?? ''}
                    onChange={(next) =>
                      setRows(field.path, (rows) =>
                        rows.map((entry, at) =>
                          at === index ? { ...entry, [item.path]: next } : entry,
                        ),
                      )
                    }
                  />
                ))}
                <div>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    disabled={(values.lists[field.path] ?? []).length <= 1}
                    onClick={() =>
                      setRows(field.path, (rows) => rows.filter((_, at) => at !== index))
                    }
                  >
                    Remove this row
                  </Button>
                </div>
              </div>
            ))}
            <div>
              <Button
                size="sm"
                variant="outline"
                icon="plus"
                onClick={() =>
                  setRows(field.path, (rows) => [...rows, emptyRow(field.item_fields ?? [])])
                }
              >
                Add a row
              </Button>
            </div>
          </fieldset>
        ) : (
          <Control
            key={field.path}
            field={{ ...field, input: field.input }}
            value={values.fields[field.path] ?? ''}
            onChange={(next) => setField(field.path, next)}
          />
        ),
      )}
      {kind.scopes.length ? (
        <fieldset className="col field-group" style={{ gap: 8 }}>
          <legend style={{ fontSize: 13, fontWeight: 500, color: 'var(--heading)' }}>
            What it may do
          </legend>
          {kind.scopes.map((scope) => (
            <span
              key={scope.scope}
              className="row"
              style={{ gap: 8, fontSize: 13, color: 'var(--heading)' }}
            >
              <Checkbox
                label={scope.label}
                checked={values.scopes[scope.scope] === true}
                onChange={(next) =>
                  setValues((current) => ({
                    ...current,
                    scopes: { ...current.scopes, [scope.scope]: next },
                  }))
                }
              />
              {scope.label}
              {scope.asks_first ? <Badge tone="outline">Asks you first</Badge> : null}
            </span>
          ))}
        </fieldset>
      ) : null}
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <Button type="submit" loading={sending} disabled={sending || gap !== null}>
          Connect and test
        </Button>
        <Button variant="ghost" disabled={sending} onClick={onDone}>
          Cancel
        </Button>
        {gap ? <span style={{ fontSize: 12, color: 'var(--muted)' }}>{gap}</span> : null}
      </div>
    </form>
  );
}

export function AddConnection({ onInstalled }: { onInstalled: () => void }) {
  const kinds = useLoad(() => adapter.connectionKinds(), []);
  const [chosen, setChosen] = useState<string | null>(null);
  const list = kinds.data?.kinds ?? [];
  const kind = list.find((item) => item.kind === chosen);
  // An instance that does not serve kinds cannot install anything, so nothing is drawn.
  if (kinds.unavailable || (!kinds.loading && !kinds.error && list.length === 0)) return null;

  return (
    <div className="col" style={{ gap: 10 }}>
      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--heading)' }}>
        Add a connection
      </span>
      {kinds.error ? <p style={{ color: 'var(--danger)', fontSize: 13 }}>{kinds.error}</p> : null}
      {kind ? (
        <KindForm
          key={kind.kind}
          kind={kind}
          onDone={() => {
            setChosen(null);
            onInstalled();
          }}
        />
      ) : (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {list.map((item) => (
            <Button
              key={item.kind}
              variant="outline"
              icon="plus"
              title={item.description}
              onClick={() => setChosen(item.kind)}
            >
              {item.title}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Test and remove, for one connection. A connection the service keeps in every
 * space is tested here and not removed: the service does not make it again.
 */
export function ConnectionActions({
  id,
  label,
  removable,
  onChanged,
}: {
  id: string;
  label: string;
  removable: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<'test' | 'remove' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const test = () => {
    setBusy('test');
    void adapter
      .testConnection(id)
      .then((result) => {
        if (result.data === null)
          toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t test that' });
        else if (result.data.check.status === 'failing')
          toast({ kind: 'err', title: `${label} is not working`, sub: result.data.check.detail });
        else toast({ kind: 'ok', title: `${label} is working`, sub: result.data.check.detail });
        onChanged();
      })
      .finally(() => setBusy(null));
  };
  const remove = () => {
    setBusy('remove');
    void adapter
      .removeConnection(id)
      .then((result) => {
        if (result.data === null) {
          toast({
            kind: 'err',
            title: result.error ?? result.unavailable ?? 'Couldn’t remove that',
          });
          return;
        }
        toast({ kind: 'ok', title: `${label} was removed` });
        onChanged();
      })
      .finally(() => {
        setBusy(null);
        setConfirming(false);
      });
  };
  return (
    <div className="row" style={{ gap: 6 }}>
      <Button
        size="sm"
        variant="outline"
        loading={busy === 'test'}
        disabled={busy !== null}
        onClick={test}
      >
        Test
      </Button>
      {!removable ? null : confirming ? (
        <>
          <Button
            size="sm"
            variant="destructive"
            loading={busy === 'remove'}
            disabled={busy !== null}
            onClick={remove}
          >
            Remove {label}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => setConfirming(false)}
          >
            Keep
          </Button>
        </>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null}
          onClick={() => setConfirming(true)}
        >
          Remove
        </Button>
      )}
    </div>
  );
}
