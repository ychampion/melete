/**
 * Settings → Privacy: what Melete swaps out before a cloud model sees a
 * request, what stays on the person's own model, and a preview of exactly what
 * a cloud model would be sent for a message they type.
 */
import { type ReactNode, useEffect, useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { Badge, Button, Field, IconButton, Input, Select, Toggle } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { useApp, useLoad } from '../experience/hooks.ts';
import { CATEGORY_NAMES, kindOf } from '../experience/privacy.ts';
import type {
  PrivacyCategory,
  PrivacyPreview,
  PrivacySettings,
  PrivacySettingsUpdate,
  SensitiveTopic,
} from '../experience/types.ts';
import { toast } from '../shell/Shell.tsx';

const LISTABLE: PrivacyCategory[] = [
  'name',
  'account',
  'card',
  'address',
  'phone',
  'email',
  'health',
  'private',
];

const TOPICS: { value: SensitiveTopic; label: string }[] = [
  { value: 'therapy', label: 'Therapy and mental health' },
  { value: 'health', label: 'Medical records and health' },
  { value: 'finance', label: 'Statements, taxes and personal finances' },
];

const SAMPLE =
  'Pay the $142.17 power bill from checking 000123456789 (routing 021000021) and send the receipt to sam.rivera@example.org.';

function Section({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card-12 col" style={{ gap: 12, padding: '16px 16px 18px' }}>
      <div className="col" style={{ gap: 4 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--heading)', margin: 0 }}>
          {title}
        </h2>
        {sub ? (
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0, maxWidth: 620 }}>{sub}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function SwitchRow({
  label,
  hint,
  on,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="row" style={{ gap: 12, justifyContent: 'space-between', minHeight: 36 }}>
      <div className="col" style={{ gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 14, color: 'var(--text)' }}>{label}</span>
        {hint ? <span style={{ fontSize: 12, color: 'var(--muted)' }}>{hint}</span> : null}
      </div>
      <Toggle on={on} onChange={onChange} label={label} disabled={disabled} />
    </div>
  );
}

/** The cloud model's view of the sample, placeholders marked. */
function Sent({ preview }: { preview: PrivacyPreview }) {
  const parts = preview.sent.split(/(⟦[A-Z_]+_\d+⟧)/g);
  const route =
    preview.route === 'local'
      ? 'This would stay on your local model, as written, and not go to a cloud model. Had it gone to one, it would have looked like this:'
      : preview.route === 'ask'
        ? 'This would stay private. With no local model, Melete asks you before sending the version below.'
        : preview.details.length
          ? `A cloud model would see this, with ${preview.details.length} detail${preview.details.length === 1 ? '' : 's'} swapped.`
          : 'A cloud model would see this as written: nothing here matched.';
  return (
    <div className="col" style={{ gap: 8 }} aria-live="polite">
      <span style={{ fontSize: 13, color: 'var(--secondary)' }}>{route}</span>
      <div
        data-testid="privacy-sent"
        style={{
          fontSize: 14,
          lineHeight: 1.6,
          padding: '10px 12px',
          borderRadius: 10,
          background: 'var(--soft)',
          color: 'var(--text)',
          overflowWrap: 'anywhere',
        }}
      >
        {parts.map((part, index) =>
          /^⟦[A-Z_]+_\d+⟧$/.test(part) ? (
            <mark
              // biome-ignore lint/suspicious/noArrayIndexKey: parts of one string, in order
              key={index}
              style={{
                background: 'var(--blue-soft)',
                color: 'var(--blue-ink)',
                borderRadius: 4,
                padding: '0 3px',
                fontWeight: 500,
              }}
            >
              {part}
            </mark>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: parts of one string, in order
            <span key={index}>{part}</span>
          ),
        )}
      </div>
    </div>
  );
}

export function PrivacyTab() {
  const { agents } = useApp();
  const loaded = useLoad(() => adapter.privacySettings(), []);
  const [settings, setSettings] = useState<PrivacySettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [sample, setSample] = useState(SAMPLE);
  const [preview, setPreview] = useState<PrivacyPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null);
  const [adding, setAdding] = useState({
    label: '',
    category: 'name' as PrivacyCategory,
    value: '',
  });

  useEffect(() => {
    if (!loaded.data) return;
    setSettings(loaded.data);
    setBaseUrl(loaded.data.local_model?.base_url ?? '');
    setModel(loaded.data.local_model?.model ?? '');
  }, [loaded.data]);

  const save = async (change: PrivacySettingsUpdate, done?: string) => {
    setSaving(true);
    const result = await adapter.savePrivacy(change);
    setSaving(false);
    if (!result.data) {
      toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t save' });
      loaded.reload();
      return false;
    }
    setSettings(result.data);
    if (done) toast({ kind: 'ok', title: done });
    return true;
  };

  /**
   * A switch changes at once and stays focused and usable; the save follows.
   * The next switch reads the changed state, so two quick changes both stand.
   */
  const flip = (
    change: Pick<
      Partial<PrivacySettings>,
      | 'enabled'
      | 'sensitive_topics'
      | 'private_space'
      | 'private_agent_ids'
      | 'local_detection'
      | 'model_on_device'
      | 'screenshots_own_computer'
      | 'screenshots_paired_devices'
    >,
  ) => {
    setSettings((current) => (current ? { ...current, ...change } : current));
    void save(change as PrivacySettingsUpdate);
  };

  const runPreview = async () => {
    if (!sample.trim()) return;
    setPreviewing(true);
    const result = await adapter.previewPrivacy(sample);
    setPreviewing(false);
    if (result.data) setPreview(result.data);
    else toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t preview' });
  };

  if (loaded.error || loaded.unavailable)
    return (
      <p style={{ color: 'var(--danger)', fontSize: 13 }}>{loaded.error ?? loaded.unavailable}</p>
    );
  if (!settings)
    return <div className="shimmer" style={{ height: 120, borderRadius: 14 }} aria-hidden="true" />;

  const enabled = new Set(settings.enabled);
  const topics = new Set(settings.sensitive_topics);
  const privateAgents = new Set(settings.private_agent_ids);

  return (
    <div className="col" style={{ gap: 14 }}>
      <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 620, margin: 0 }}>
        Before anything goes to a cloud model, Melete swaps these details for placeholders such as
        ⟦ACCOUNT_1⟧ and puts the real values back on this machine. The most private work runs on
        your own model instead.
      </p>
      {settings.model_on_device ? (
        <div className="row" style={{ gap: 8, fontSize: 13, color: 'var(--secondary)' }}>
          <Icon name="lock" size={14} />
          You marked your model’s address as a model you run, so requests to it are sent as written.
        </div>
      ) : null}
      {!settings.sealed_vault ? (
        <div className="row" style={{ gap: 8, fontSize: 13, color: 'var(--danger)' }}>
          <Icon name="alert" size={14} />
          This service has no master key, so swapped details are not kept between requests and you
          can’t list private values yet.
        </div>
      ) : null}

      <Section
        title="See what a cloud model would get"
        sub="Type or paste a message. Nothing here is sent anywhere or saved."
      >
        <textarea
          aria-label="Sample message"
          value={sample}
          onChange={(event) => setSample(event.target.value)}
          rows={3}
          className="textarea"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            resize: 'vertical',
            font: 'inherit',
            fontSize: 14,
            padding: '10px 12px',
            borderRadius: 10,
            border: '1px solid var(--line)',
            background: 'var(--surface, transparent)',
            color: 'var(--text)',
          }}
        />
        <div className="row" style={{ gap: 8 }}>
          <Button onClick={() => void runPreview()} loading={previewing} disabled={previewing}>
            Preview
          </Button>
        </div>
        {preview ? <Sent preview={preview} /> : null}
      </Section>

      <Section
        title="What to swap out"
        sub="Each kind of detail found in a request to a cloud model."
      >
        <div className="col" style={{ gap: 4 }}>
          {(Object.keys(CATEGORY_NAMES) as PrivacyCategory[]).map((category) => (
            <SwitchRow
              key={category}
              label={CATEGORY_NAMES[category]}
              on={enabled.has(category)}
              onChange={(next) =>
                flip({
                  enabled: next
                    ? [...enabled, category]
                    : [...enabled].filter((value) => value !== category),
                })
              }
            />
          ))}
        </div>
      </Section>

      {settings.model_address_local ? (
        <Section
          title="Your model’s address"
          sub={`Your model is set to ${settings.model_address ?? 'an address'}, which is on this machine or your network. That can be a model you run, or a proxy or gateway that passes requests on to a cloud service, so Melete still swaps details out of what it sends there.`}
        >
          <SwitchRow
            label="This is a model running on a machine I control"
            hint="Turn this on only if it answers requests itself and does not pass them on. Requests to it are then sent as written, and private conversations can run on it."
            on={settings.model_on_device}
            onChange={(next) => flip({ model_on_device: next })}
          />
        </Section>
      ) : null}

      <Section
        title="Keep private work on your own model"
        sub="These conversations stay on your local model. Without one, Melete asks you first and sends only a redacted version if you agree."
      >
        <SwitchRow
          label="Everything in this space"
          on={settings.private_space}
          onChange={(next) => flip({ private_space: next })}
        />
        {TOPICS.map((topic) => (
          <SwitchRow
            key={topic.value}
            label={topic.label}
            hint="Found only from what you write. Pages, files and emails an agent reads never decide it."
            on={topics.has(topic.value)}
            onChange={(next) =>
              flip({
                sensitive_topics: next
                  ? [...topics, topic.value]
                  : [...topics].filter((value) => value !== topic.value),
              })
            }
          />
        ))}
        {agents.length ? (
          <div className="col" style={{ gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--heading)', marginTop: 4 }}>
              Private agents
            </span>
            {agents.map((agent) => (
              <SwitchRow
                key={agent.id}
                label={agent.name}
                hint={agent.role}
                on={privateAgents.has(agent.id)}
                onChange={(next) =>
                  flip({
                    private_agent_ids: next
                      ? [...privateAgents, agent.id]
                      : [...privateAgents].filter((value) => value !== agent.id),
                  })
                }
              />
            ))}
          </div>
        ) : null}
      </Section>

      <Section
        title="Local model"
        sub="An OpenAI-compatible server on this machine or your network, such as Ollama, llama.cpp or vLLM."
      >
        <form
          className="col"
          style={{ gap: 10 }}
          onSubmit={(event) => {
            event.preventDefault();
            void save(
              {
                local_model: {
                  base_url: baseUrl.trim(),
                  model: model.trim(),
                  ...(apiKey ? { api_key: apiKey } : {}),
                },
              },
              'Local model saved',
            ).then((ok) => ok && setApiKey(''));
          }}
        >
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: '2 1 240px', minWidth: 0 }}>
              <Field label="Address">
                <Input
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="http://127.0.0.1:11434/v1"
                  width="100%"
                  inputMode="url"
                />
              </Field>
            </div>
            <div style={{ flex: '1 1 160px', minWidth: 0 }}>
              <Field label="Model">
                <Input
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder="llama3.3"
                  width="100%"
                />
              </Field>
            </div>
          </div>
          <Field
            label="Key (optional)"
            hint={
              settings.local_model?.has_key
                ? 'A key is saved. Type a new one to replace it.'
                : undefined
            }
          >
            <Input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              autoComplete="off"
              width="100%"
            />
          </Field>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Button type="submit" disabled={saving || !baseUrl.trim() || !model.trim()}>
              Save
            </Button>
            <Button
              variant="outline"
              type="button"
              disabled={!baseUrl.trim() || !model.trim()}
              onClick={() =>
                void adapter
                  .checkLocalModel({
                    base_url: baseUrl.trim(),
                    model: model.trim(),
                    ...(apiKey ? { api_key: apiKey } : {}),
                  })
                  .then((result) =>
                    setCheck(
                      result.data ?? { ok: false, message: result.error ?? 'Couldn’t check' },
                    ),
                  )
              }
            >
              Check
            </Button>
            {settings.local_model ? (
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={() =>
                  void save({ local_model: null }, 'Local model removed').then((ok) => {
                    if (!ok) return;
                    setBaseUrl('');
                    setModel('');
                    setCheck(null);
                  })
                }
              >
                Remove
              </Button>
            ) : null}
            {check ? (
              <Badge tone={check.ok ? 'success' : 'danger'} dot>
                {check.message}
              </Badge>
            ) : null}
          </div>
        </form>
        <SwitchRow
          label="Let the local model find names, addresses and health details too"
          hint="Slower: each new message is read by your model first."
          on={settings.local_detection}
          disabled={!settings.local_model}
          onChange={(next) => flip({ local_detection: next })}
        />
      </Section>

      <Section
        title="Screenshots sent to cloud models"
        sub="When the agent works on a computer it can look at the screen. A cloud model that reads images is shown those screenshots in ordinary conversations only if you allow it here."
      >
        <SwitchRow
          label="The agent's own computer and browser"
          hint="Its own sandbox, where it browses and works for you."
          on={settings.screenshots_own_computer}
          onChange={(next) => flip({ screenshots_own_computer: next })}
        />
        <SwitchRow
          label="Your paired computers"
          hint="Your own screens. Each computer can say otherwise under Devices."
          on={settings.screenshots_paired_devices}
          onChange={(next) => flip({ screenshots_paired_devices: next })}
        />
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
          Screenshots are pictures, so nothing in them is swapped for a placeholder: the details
          above and your Always protect list apply to text only. Private conversations never send
          screenshots to a cloud model; your local model sees them only if it reads images.
        </p>
      </Section>

      <Section
        title="Always protect"
        sub="Names of people close to you, your accounts, your address: listed here, they are swapped wherever they appear. Kept sealed on this machine."
      >
        {settings.known_values.length ? (
          <div className="col" style={{ gap: 2 }}>
            {settings.known_values.map((known) => (
              <div key={known.id} className="row" style={{ gap: 10, minHeight: 40 }}>
                <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
                  <span style={{ fontSize: 14, color: 'var(--heading)' }}>{known.label}</span>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {kindOf(known.category)} · {known.hint}
                  </span>
                </div>
                <IconButton
                  name="trash"
                  label={`Stop protecting ${known.label}`}
                  size={28}
                  iconSize={14}
                  onClick={() => void save({ remove_known_values: [known.id] }, 'Removed')}
                />
              </div>
            ))}
          </div>
        ) : null}
        <form
          className="row"
          style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}
          onSubmit={(event) => {
            event.preventDefault();
            if (!adding.label.trim() || adding.value.trim().length < 2) return;
            void save(
              {
                add_known_values: [
                  { ...adding, label: adding.label.trim(), value: adding.value.trim() },
                ],
              },
              'Added',
            ).then((ok) => ok && setAdding({ label: '', category: adding.category, value: '' }));
          }}
        >
          <div style={{ flex: '1 1 140px', minWidth: 0 }}>
            <Field label="What it is">
              <Input
                value={adding.label}
                onChange={(event) => setAdding({ ...adding, label: event.target.value })}
                placeholder="My sister"
                width="100%"
              />
            </Field>
          </div>
          <div style={{ flex: '1 1 150px', minWidth: 0 }}>
            <Field label="Kind">
              <Select
                label="Kind"
                value={adding.category}
                onChange={(value) => setAdding({ ...adding, category: value as PrivacyCategory })}
                options={LISTABLE.map((category) => ({ value: category, label: kindOf(category) }))}
                width="100%"
              />
            </Field>
          </div>
          <div style={{ flex: '2 1 180px', minWidth: 0 }}>
            <Field label="Value">
              <Input
                value={adding.value}
                onChange={(event) => setAdding({ ...adding, value: event.target.value })}
                placeholder="Priya Rivera"
                autoComplete="off"
                width="100%"
              />
            </Field>
          </div>
          <Button type="submit" disabled={saving || !settings.sealed_vault}>
            Add
          </Button>
        </form>
      </Section>
    </div>
  );
}
