/**
 * Settings → Space rules: what work in this space may use. The models it may
 * run on (none listed means any), and the kinds of connected app and tool kept
 * out of it. The space's owner and whoever set up the installation change
 * them; with nothing listed, nothing is restricted.
 */
import { type FormEvent, useEffect, useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { LoadError } from '../design/LoadError.tsx';
import { Button, Chip, Field, Input } from '../design/primitives.tsx';
import { adapter, type Result } from '../experience/adapter.ts';
import { useLoad } from '../experience/hooks.ts';
import { assistantName } from '../experience/instance.ts';
import type { SpaceRulesChange, SpaceRulesView } from '../experience/types.ts';
import { toast } from '../shell/Shell.tsx';

type ListKey = keyof SpaceRulesChange;

const LISTS: readonly {
  key: ListKey;
  label: string;
  hint: string;
  placeholder: string;
}[] = [
  {
    key: 'allowed_models',
    label: 'Models this space may use',
    hint: 'Written provider/model. Leave empty to allow any model. When the chosen model is not listed, work moves to the first listed model that is connected.',
    placeholder: 'provider/model',
  },
  {
    key: 'denied_connector_kinds',
    label: 'Kinds of app kept out',
    hint: 'By provider, such as imap, caldav or mcp. Apps of these kinds cannot be added here, and ones already added are not used.',
    placeholder: 'imap',
  },
  {
    key: 'denied_tool_kinds',
    label: 'Tools kept out',
    hint: 'A tool by name, such as email.send, or a whole family, such as email. The agent is not offered them and is refused if it asks.',
    placeholder: 'email.send',
  },
];

const EMPTY: SpaceRulesChange = {
  allowed_models: [],
  denied_connector_kinds: [],
  denied_tool_kinds: [],
};

/** Each value once, trimmed, with kinds in lower case as the service keeps them. */
export function addTo(list: readonly string[], key: ListKey, value: string): string[] {
  const trimmed = key === 'allowed_models' ? value.trim() : value.trim().toLowerCase();
  if (!trimmed || list.includes(trimmed)) return [...list];
  return [...list, trimmed];
}

export function SpaceRules({ spaceId }: { spaceId: string | undefined }) {
  const loaded = useLoad(
    () =>
      spaceId
        ? adapter.spaceRules(spaceId)
        : Promise.resolve<Result<SpaceRulesView>>({
            data: null,
            error: null,
            unavailable: 'Loading your space…',
          }),
    [spaceId],
  );
  const [draft, setDraft] = useState<SpaceRulesChange>(EMPTY);
  const [typed, setTyped] = useState<Record<ListKey, string>>({
    allowed_models: '',
    denied_connector_kinds: '',
    denied_tool_kinds: '',
  });
  const [saving, setSaving] = useState(false);
  const policy = loaded.data?.policy;
  const canChange = loaded.data?.can_change === true;

  useEffect(() => {
    if (!policy) return;
    setDraft({
      allowed_models: policy.allowed_models,
      denied_connector_kinds: policy.denied_connector_kinds,
      denied_tool_kinds: policy.denied_tool_kinds,
    });
  }, [policy]);

  const changed =
    policy !== undefined &&
    LISTS.some(({ key }) => draft[key].join('\n') !== policy[key].join('\n'));

  const add = (key: ListKey) => (event: FormEvent) => {
    event.preventDefault();
    setDraft({ ...draft, [key]: addTo(draft[key], key, typed[key]) });
    setTyped({ ...typed, [key]: '' });
  };
  const remove = (key: ListKey, value: string) =>
    setDraft({ ...draft, [key]: draft[key].filter((item) => item !== value) });

  const save = async () => {
    if (!spaceId) return;
    setSaving(true);
    const result = await adapter.setSpaceRules(spaceId, draft);
    setSaving(false);
    if (!result.data) {
      toast({
        kind: 'err',
        title: result.error ?? result.unavailable ?? 'Couldn’t save the rules',
      });
      return;
    }
    loaded.set(result.data);
    toast({
      kind: 'ok',
      title: 'Rules saved',
      sub: `They apply from the next thing ${assistantName()} does.`,
    });
  };

  if (loaded.error)
    return <LoadError what="this space’s rules" error={loaded.error} onRetry={loaded.reload} />;
  if (!loaded.data)
    return (
      <p style={{ fontSize: 13, color: 'var(--muted)' }}>{loaded.unavailable ?? 'Loading…'}</p>
    );

  return (
    <div className="col" style={{ gap: 16, maxWidth: 640 }}>
      <p style={{ fontSize: 13, color: 'var(--muted)' }}>
        {canChange
          ? 'What work in this space may use. With nothing listed, nothing is restricted.'
          : 'What work in this space may use. The space’s owner chooses these.'}
      </p>
      {LISTS.map(({ key, label, hint, placeholder }) => (
        <div key={key} className="card-12 col" style={{ gap: 10, padding: 16 }}>
          <Field label={label} hint={hint}>
            <div className="col" style={{ gap: 10 }}>
              {draft[key].length ? (
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  {draft[key].map((value) => (
                    <Chip
                      key={value}
                      size={28}
                      disabled={!canChange}
                      onClick={() => remove(key, value)}
                      aria-label={`Remove ${value}`}
                      title={canChange ? `Remove ${value}` : value}
                    >
                      <span className="row" style={{ gap: 4, alignItems: 'center' }}>
                        <span style={{ overflowWrap: 'anywhere' }}>{value}</span>
                        {canChange ? <Icon name="x" size={12} /> : null}
                      </span>
                    </Chip>
                  ))}
                </div>
              ) : (
                <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                  {key === 'allowed_models' ? 'Any model.' : 'Nothing kept out.'}
                </span>
              )}
              {canChange ? (
                <form className="row" style={{ gap: 8 }} onSubmit={add(key)}>
                  <Input
                    aria-label={`Add to ${label.toLowerCase()}`}
                    placeholder={placeholder}
                    value={typed[key]}
                    onChange={(event) => setTyped({ ...typed, [key]: event.target.value })}
                    width="100%"
                  />
                  <Button type="submit" variant="outline" disabled={!typed[key].trim()}>
                    Add
                  </Button>
                </form>
              ) : null}
            </div>
          </Field>
        </div>
      ))}
      {canChange ? (
        <div className="row" style={{ gap: 8 }}>
          <Button onClick={() => void save()} disabled={!changed || saving} loading={saving}>
            Save rules
          </Button>
          {changed ? (
            <Button
              variant="ghost"
              onClick={() =>
                setDraft({
                  allowed_models: policy?.allowed_models ?? [],
                  denied_connector_kinds: policy?.denied_connector_kinds ?? [],
                  denied_tool_kinds: policy?.denied_tool_kinds ?? [],
                })
              }
            >
              Undo changes
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
