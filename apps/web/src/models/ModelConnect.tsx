/**
 * Connecting the model agents answer with, from the app instead of the
 * server's environment file: pick a provider, paste a key (or sign in to
 * ChatGPT), test it, choose a model and use it. The next reply uses it;
 * nothing restarts. A key the server configuration sets is shown as the
 * operator's and never replaced here. No key is ever shown back, only its
 * last four characters.
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { Badge, Button, Field, Input, Select, Toggle } from '../design/primitives.tsx';
import { type Loaded, useLoad } from '../experience/hooks.ts';
import { modelDisplayName } from '../experience/model-name.ts';
import { toast } from '../shell/Shell.tsx';
import {
  type ConnectionTest,
  type ModelProvider,
  type ModelProviderStatus,
  type ModelSettings,
  models,
  providerLabel,
  type SignInStart,
  type SignInStatus,
} from './api.ts';
import './models.css';

/** Where each provider hands out keys, in the words its own console uses. */
const KEY_HINT: Partial<Record<ModelProvider, string>> = {
  anthropic: 'Create one in the Anthropic Console under API keys.',
  openai: 'Create one on the OpenAI platform under API keys.',
  google: 'Create one in Google AI Studio under Get API key.',
  fireworks: 'Create one in your Fireworks account under API keys.',
  'openai-compatible':
    'Any server that speaks the OpenAI API: a hosted gateway, or a model server on your own network. If it checks no key, enter any value.',
};

const BLURB: Record<ModelProvider, string> = {
  anthropic: 'Claude models',
  openai: 'GPT models',
  google: 'Gemini models',
  fireworks: 'Open models, hosted',
  'openai-compatible': 'Your own endpoint',
  chatgpt: 'Your ChatGPT plan',
};

/**
 * The state a provider tile shows. A tick is shown only for a credential that
 * is really there: the server's default provider with no key says it needs one.
 */
export function statusLine(
  status: ModelProviderStatus,
  serverDefault = false,
): { text: string; tone: 'ok' | 'muted' | 'attention' } {
  if (status.method === 'sign_in')
    return status.connected
      ? { text: 'Signed in', tone: 'ok' }
      : { text: 'Not signed in', tone: 'muted' };
  if (status.key.state === 'operator' && status.connected)
    return { text: 'Set by the operator', tone: 'ok' };
  if (!status.connected && serverDefault)
    return { text: 'Server default · needs a key', tone: 'attention' };
  if (status.key.state === 'set')
    return { text: `Key ••••${status.key.last_four ?? ''}`, tone: 'ok' };
  return { text: 'Not connected', tone: 'muted' };
}

/** What the active model does with the screenshots agents take, in plain words. */
export function visionLine(active: ModelSettings['active']): { text: string; hint: string } {
  const text = active.vision
    ? 'Sees screenshots as pictures'
    : 'Gets screenshots as text: where each was saved and its size';
  const hint =
    active.vision_source === 'app'
      ? 'You set this for this model.'
      : active.vision_source === 'operator'
        ? 'Set in the server’s configuration.'
        : active.vision
          ? 'This model reads images, by Melete’s list.'
          : active.provider_vision
            ? 'Your provider says this model can read images. Turn this on to send it screenshots as pictures.'
            : 'Melete doesn’t know this model to read images. If it does, turn this on.';
  return { text, hint };
}

/** Whether the owner can change the active model's answer here: it has to be one they could choose. */
export function canSetVision(settings: ModelSettings): boolean {
  return (
    settings.can_edit &&
    settings.active.connected &&
    settings.providers.some((entry) => entry.provider === settings.active.provider)
  );
}

function VisionSetting({
  settings,
  onChanged,
}: {
  settings: ModelSettings;
  onChanged: (next: ModelSettings) => void;
}) {
  const [busy, setBusy] = useState(false);
  const { active } = settings;
  const line = visionLine(active);
  const save = (next: boolean | null, done: string) => {
    setBusy(true);
    void models.choose(active.provider as ModelProvider, active.model, next).then((result) => {
      setBusy(false);
      if (result.data === null) {
        toast({ kind: 'err', title: result.error ?? 'Couldn’t change that' });
        return;
      }
      onChanged(result.data);
      toast({ kind: 'ok', title: done });
    });
  };
  return (
    <div className="models-vision row" style={{ gap: 12, alignItems: 'flex-start' }}>
      <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 13, color: 'var(--heading)' }}>{line.text}</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{line.hint}</span>
        {active.vision_source === 'app' && canSetVision(settings) ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            style={{ alignSelf: 'flex-start' }}
            onClick={() => save(null, 'Back to Melete’s list for this model')}
          >
            Use Melete’s list
          </Button>
        ) : null}
      </div>
      {canSetVision(settings) ? (
        <Toggle
          label={`${modelDisplayName(active.model)} reads images`}
          on={active.vision}
          disabled={busy}
          onChange={(next) =>
            save(next, next ? 'Screenshots go to it as pictures' : 'Screenshots go to it as text')
          }
        />
      ) : null}
    </div>
  );
}

/** Which model agents answer with now, and whether it came from here or from the server. */
export function ActiveModel({
  settings,
  onChanged,
}: {
  settings: ModelSettings;
  onChanged: (next: ModelSettings) => void;
}) {
  const [busy, setBusy] = useState(false);
  const { active, operator_default: server } = settings;
  return (
    <div className="card-12 models-active">
      <div className="col grow" style={{ gap: 4, minWidth: 0 }}>
        <span className="models-overline">Agents answer with</span>
        <span className="models-active-name" title={active.model}>
          {modelDisplayName(active.model)}
        </span>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>
          {providerLabel(settings, active.provider)} ·{' '}
          {active.source === 'app' ? 'chosen here' : 'the server’s default'}
        </span>
        <VisionSetting settings={settings} onChanged={onChanged} />
        {active.connected ? null : (
          <span className="models-warning" role="note">
            <Icon name="alert" size={14} />
            {active.provider === 'fake'
              ? 'This is the scripted demonstration model.'
              : `${providerLabel(settings, active.provider)} has no key or sign-in here yet, so agents can’t answer.`}
          </span>
        )}
      </div>
      <div className="col models-active-side">
        {active.connected ? (
          <Badge tone="success" dot>
            Connected
          </Badge>
        ) : (
          <Badge tone="danger" dot>
            Not connected
          </Badge>
        )}
        {active.source === 'app' && settings.can_edit ? (
          <Button
            size="sm"
            variant="ghost"
            loading={busy}
            disabled={busy}
            title={`${modelDisplayName(server.model)} (${server.model}) · ${providerLabel(settings, server.provider)}`}
            onClick={() => {
              setBusy(true);
              void models.restoreServerDefault().then((result) => {
                setBusy(false);
                if (result.data === null) {
                  toast({ kind: 'err', title: result.error ?? 'Couldn’t change the model' });
                  return;
                }
                onChanged(result.data);
                toast({ kind: 'ok', title: 'Back to the server’s default model' });
              });
            }}
          >
            Use the server default
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Pick a provider, connect it, choose a model and use it. Only the owner sees this. */
export function ModelConnect({
  settings,
  onChanged,
}: {
  settings: ModelSettings;
  onChanged: (next: ModelSettings) => void;
}) {
  const initial = settings.providers.some((entry) => entry.provider === settings.active.provider)
    ? (settings.active.provider as ModelProvider)
    : 'anthropic';
  const [selected, setSelected] = useState<ModelProvider>(initial);
  // ChatGPT is offered, as on the sign-in page, only when this server is set up for its sign-in.
  const hasSignIn = settings.providers.some((entry) => entry.method === 'sign_in');
  const chatgpt = useLoad(
    () =>
      hasSignIn
        ? models.signInStatus('chatgpt')
        : Promise.resolve({ data: null, error: null, unavailable: 'none' } as const),
    [hasSignIn],
  );
  const signInReady =
    chatgpt.data !== null &&
    (chatgpt.data.state === 'signed_in' || chatgpt.data.methods.length > 0);
  const providers = settings.providers.filter(
    (entry) => entry.method !== 'sign_in' || entry.connected || signInReady,
  );
  const status = providers.find((entry) => entry.provider === selected);
  return (
    <div className="col" style={{ gap: 14 }}>
      <fieldset className="models-fieldset">
        <legend className="models-overline">Provider</legend>
        <div className="models-providers">
          {providers.map((entry) => {
            const line = statusLine(
              entry,
              entry.provider === settings.operator_default.provider &&
                settings.active.source === 'operator',
            );
            const on = entry.provider === selected;
            const inUse = entry.provider === settings.active.provider;
            return (
              <button
                key={entry.provider}
                type="button"
                className="models-provider"
                aria-pressed={on}
                data-on={on ? 'true' : undefined}
                onClick={() => setSelected(entry.provider)}
              >
                <span className="row" style={{ gap: 6, justifyContent: 'space-between' }}>
                  <span className="models-provider-name">{entry.label}</span>
                  {inUse ? <span className="models-in-use">In use</span> : null}
                </span>
                <span className="models-provider-blurb">{BLURB[entry.provider]}</span>
                <span className="models-provider-state" data-tone={line.tone}>
                  {line.tone === 'ok' ? <Icon name="check" size={12} /> : null}
                  {line.text}
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>
      {status ? (
        status.method === 'sign_in' ? (
          <SignInPanel
            key={status.provider}
            status={status}
            settings={settings}
            onChanged={onChanged}
          />
        ) : (
          <KeyPanel
            key={status.provider}
            status={status}
            settings={settings}
            onChanged={onChanged}
          />
        )
      ) : null}
    </div>
  );
}

function TestResult({ result }: { result: ConnectionTest | null }) {
  if (!result) return null;
  return result.ok ? (
    <span className="models-result" data-tone="ok">
      <Icon name="circleCheck" size={16} />
      {result.models.length
        ? `Connected. ${result.models.length} model${result.models.length === 1 ? '' : 's'} available to choose from.`
        : 'Connected. This provider lists no models, so type the one to use.'}
    </span>
  ) : (
    <span className="models-result" data-tone="err">
      <Icon name="circleX" size={16} />
      {result.message}
    </span>
  );
}

/** The model to use: the provider's list when a test returned one, otherwise typed. */
/**
 * The provider's models by the names people read, each with its exact id on hover.
 * Two ids that read the same (dated builds of one model) keep their ids beside them.
 */
function modelOptions(ids: string[]) {
  const names = ids.map(modelDisplayName);
  return ids.map((id, index) => {
    const name = names[index] ?? id;
    const shared = names.filter((other) => other === name).length > 1;
    return { value: id, label: shared ? `${name} (${id})` : name, title: id };
  });
}

function ModelChoice({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  options: string[];
  placeholder: string;
}) {
  const [typing, setTyping] = useState(false);
  const listed = options.length > 0 && !typing;
  return (
    <div className="col" style={{ gap: 6 }}>
      {listed ? (
        <Field label="Model">
          <Select
            label="Model"
            value={options.includes(value) ? value : ''}
            onChange={onChange}
            width="100%"
            options={[{ value: '', label: 'Choose a model' }, ...modelOptions(options)]}
          />
        </Field>
      ) : (
        <Field label="Model">
          <Input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={placeholder}
            width="100%"
            autoComplete="off"
            spellCheck={false}
            maxLength={300}
          />
        </Field>
      )}
      {options.length > 0 ? (
        <button type="button" className="models-link" onClick={() => setTyping(!typing)}>
          {typing ? 'Choose from the provider’s list' : 'Type a model name instead'}
        </button>
      ) : null}
    </div>
  );
}

function KeyPanel({
  status,
  settings,
  onChanged,
}: {
  status: ModelProviderStatus;
  settings: ModelSettings;
  onChanged: (next: ModelSettings) => void;
}) {
  const operator = status.key.state === 'operator';
  const compatible = status.provider === 'openai-compatible';
  const operatorAddress = status.base_url_source === 'operator';
  const inUse = settings.active.provider === status.provider;
  const [key, setKey] = useState('');
  const [address, setAddress] = useState(status.base_url ?? '');
  const [model, setModel] = useState(inUse ? settings.active.model : '');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [result, setResult] = useState<ConnectionTest | null>(null);
  const addressChanged =
    compatible && !operatorAddress && address.trim() !== (status.base_url ?? '');
  const hasKey = key.trim().length > 0 || (status.connected && !addressChanged);
  const listed = result?.ok ? result.models : [];
  const canTest = hasKey && (!compatible || address.trim().length > 0 || operatorAddress);
  // A typed key has to be stored before it can be used, which needs the master key.
  const canUse = model.trim().length > 0 && canTest && (settings.can_store_keys || !key.trim());

  const test = () => {
    setTesting(true);
    setResult(null);
    void models
      .test({
        provider: status.provider,
        ...(key.trim() ? { api_key: key.trim() } : {}),
        ...(compatible && !operatorAddress && address.trim() ? { base_url: address.trim() } : {}),
      })
      .then((answer) => {
        setTesting(false);
        if (answer.data === null) {
          setResult({
            ok: false,
            code: 'provider_error',
            message: answer.error ?? '',
            status: null,
          });
          return;
        }
        setResult(answer.data);
      });
  };

  const use = async () => {
    setSaving(true);
    if (key.trim() || addressChanged) {
      const saved = await models.saveKey(status.provider, {
        api_key: key.trim(),
        ...(compatible && !operatorAddress ? { base_url: address.trim() } : {}),
      });
      if (saved.data === null) {
        setSaving(false);
        toast({ kind: 'err', title: 'Couldn’t save the key', sub: saved.error ?? '' });
        return;
      }
      setKey('');
      onChanged(saved.data);
    }
    const chosen = await models.choose(status.provider, model.trim());
    setSaving(false);
    if (chosen.data === null) {
      toast({ kind: 'err', title: 'Couldn’t change the model', sub: chosen.error ?? '' });
      return;
    }
    onChanged(chosen.data);
    toast({
      kind: 'ok',
      title: `Agents now answer with ${modelDisplayName(model)}`,
      sub: 'From the next reply. Nothing needed a restart.',
    });
  };

  return (
    <div className="card-12 models-panel">
      <div className="col" style={{ gap: 4 }}>
        <span className="models-panel-title">{status.label}</span>
        {KEY_HINT[status.provider] ? (
          <span className="models-hint">{KEY_HINT[status.provider]}</span>
        ) : null}
      </div>
      {compatible ? (
        operatorAddress ? (
          <ReadOnly label="Address">
            <span className="models-id">{status.base_url}</span> · set by the operator
          </ReadOnly>
        ) : (
          <Field label="Address" hint="The endpoint’s version prefix. It usually ends in /v1.">
            <Input
              value={address}
              onChange={(event) => {
                setAddress(event.target.value);
                setResult(null);
              }}
              placeholder="https://models.example.net/v1"
              width="100%"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        )
      ) : null}
      {operator ? (
        <ReadOnly label="API key">
          Set by the operator in the server configuration. It is used as it is and can’t be changed
          here.
        </ReadOnly>
      ) : !settings.can_store_keys ? (
        <ReadOnly label="API key">
          This server has no MELETE_MASTER_KEY, so it can’t store a key safely. Ask whoever runs it
          to set one.
        </ReadOnly>
      ) : (
        <Field
          label="API key"
          hint={
            status.key.state === 'set'
              ? `A key ending in ${status.key.last_four} is saved. Paste a new one to replace it.`
              : 'Stored encrypted on this server. It is never shown again, only its last four characters.'
          }
        >
          <Input
            value={key}
            onChange={(event) => {
              setKey(event.target.value);
              setResult(null);
            }}
            type="password"
            placeholder={
              status.key.state === 'set' ? `••••${status.key.last_four}` : 'Paste the key'
            }
            width="100%"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      )}
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <Button
          variant="outline"
          icon="refresh"
          loading={testing}
          disabled={testing || !canTest}
          onClick={test}
        >
          Test connection
        </Button>
        {status.key.state === 'set' ? (
          <Button
            variant="ghost"
            icon="trash"
            loading={removing}
            disabled={removing}
            onClick={() => {
              setRemoving(true);
              void models.removeKey(status.provider).then((answer) => {
                setRemoving(false);
                if (answer.data === null) {
                  toast({ kind: 'err', title: answer.error ?? 'Couldn’t remove the key' });
                  return;
                }
                setResult(null);
                onChanged(answer.data);
                toast({ kind: 'ok', title: `Removed the ${status.label} key` });
              });
            }}
          >
            Remove key
          </Button>
        ) : null}
      </div>
      <div aria-live="polite">
        <TestResult result={result} />
      </div>
      <ModelChoice
        value={model}
        onChange={setModel}
        options={listed}
        placeholder="The model id, as the provider writes it"
      />
      <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <Button
          loading={saving}
          disabled={saving || !canUse}
          onClick={() => void use()}
          iconRight="chevronRight"
        >
          {key.trim() ? 'Save and use this model' : 'Use this model'}
        </Button>
        {inUse ? <span className="models-hint">This provider is in use now.</span> : null}
      </div>
    </div>
  );
}

function ReadOnly({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="col" style={{ gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--heading)' }}>{label}</span>
      <span className="models-readonly">{children}</span>
    </div>
  );
}

function SignInPanel({
  status,
  settings,
  onChanged,
}: {
  status: ModelProviderStatus;
  settings: ModelSettings;
  onChanged: (next: ModelSettings) => void;
}) {
  const signIn = useLoad(() => models.signInStatus(status.provider), [status.provider]);
  const inUse = settings.active.provider === status.provider;
  const [model, setModel] = useState(inUse ? settings.active.model : '');
  const [started, setStarted] = useState<SignInStart | null>(null);
  const [callback, setCallback] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const polling = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (polling.current) clearTimeout(polling.current);
    },
    [],
  );

  const refresh = async (next?: SignInStatus) => {
    if (next) signIn.set(next);
    else signIn.reload();
    const fresh = await models.settings();
    if (fresh.data) onChanged(fresh.data);
  };

  const start = (method: 'device' | 'browser') => {
    setBusy(true);
    setProblem(null);
    void models.startSignIn(status.provider, method).then((answer) => {
      setBusy(false);
      if (answer.data === null) {
        setProblem(answer.error ?? 'The sign-in could not start.');
        return;
      }
      setStarted(answer.data);
      if (answer.data.method === 'device') poll(answer.data.sign_in_id, answer.data.interval);
    });
  };

  const poll = (id: string, interval: number) => {
    polling.current = setTimeout(() => {
      void models.completeSignIn(status.provider, { sign_in_id: id }).then((answer) => {
        if (answer.data === null) {
          setProblem(answer.error ?? 'The sign-in did not finish.');
          setStarted(null);
          return;
        }
        if ('interval' in answer.data) {
          poll(id, answer.data.interval);
          return;
        }
        setStarted(null);
        void refresh(answer.data as SignInStatus);
        toast({ kind: 'ok', title: `Signed in to ${status.label}` });
      });
    }, interval * 1000);
  };

  const finish = () => {
    if (!started) return;
    setBusy(true);
    setProblem(null);
    void models
      .completeSignIn(status.provider, {
        sign_in_id: started.sign_in_id,
        callback_url: callback.trim(),
      })
      .then((answer) => {
        setBusy(false);
        if (answer.data === null) {
          setProblem(answer.error ?? 'The sign-in did not finish.');
          return;
        }
        setStarted(null);
        setCallback('');
        void refresh(answer.data as SignInStatus);
        toast({ kind: 'ok', title: `Signed in to ${status.label}` });
      });
  };

  const use = () => {
    setBusy(true);
    void models.choose(status.provider, model.trim()).then((answer) => {
      setBusy(false);
      if (answer.data === null) {
        toast({ kind: 'err', title: 'Couldn’t change the model', sub: answer.error ?? '' });
        return;
      }
      onChanged(answer.data);
      toast({
        kind: 'ok',
        title: `Agents now answer with ${modelDisplayName(model)}`,
        sub: 'From the next reply. Nothing needed a restart.',
      });
    });
  };

  const state = signIn.data;
  return (
    <div className="card-12 models-panel">
      <div className="col" style={{ gap: 4 }}>
        <span className="models-panel-title">{status.label}</span>
        <span className="models-hint">
          Use the models in your ChatGPT plan by signing in once. Melete keeps the sign-in sealed on
          this server and renews it.
        </span>
      </div>
      {signIn.error ? <span className="models-readonly">{signIn.error}</span> : null}
      {state?.message ? <span className="models-readonly">{state.message}</span> : null}
      {state?.state === 'signed_in' ? (
        <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="models-result" data-tone="ok">
            <Icon name="circleCheck" size={16} />
            Signed in{state.account ? ` as ${state.account}` : ''}.
          </span>
          <Button
            size="sm"
            variant="ghost"
            icon="logout"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void models.signOut(status.provider).then((answer) => {
                setBusy(false);
                if (answer.data === null) {
                  toast({ kind: 'err', title: answer.error ?? 'Couldn’t sign out' });
                  return;
                }
                void refresh(answer.data);
              });
            }}
          >
            Sign out
          </Button>
        </div>
      ) : state && !started ? (
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          {state.methods.includes('browser') ? (
            <Button loading={busy} disabled={busy} onClick={() => start('browser')}>
              Sign in with ChatGPT
            </Button>
          ) : null}
          {state.methods.includes('device') ? (
            <Button
              variant={state.methods.includes('browser') ? 'outline' : 'primary'}
              disabled={busy}
              onClick={() => start('device')}
            >
              Sign in with a code
            </Button>
          ) : null}
        </div>
      ) : null}
      {started?.method === 'device' ? (
        <div className="col models-steps" aria-live="polite">
          <span>
            Open{' '}
            <a href={started.verification_url} target="_blank" rel="noreferrer">
              {started.verification_url}
            </a>{' '}
            and enter this code:
          </span>
          <span className="models-code">{started.user_code}</span>
          <span className="models-hint">
            This page moves on by itself once the code is entered.
          </span>
        </div>
      ) : null}
      {started?.method === 'browser' ? (
        <div className="col models-steps">
          <span>
            1.{' '}
            <a href={started.authorize_url} target="_blank" rel="noreferrer">
              Open the ChatGPT sign-in
            </a>{' '}
            and approve it.
          </span>
          <span>2. Copy the whole address the browser ends on, and paste it here.</span>
          <Field label="Address the browser ended on">
            <Input
              value={callback}
              onChange={(event) => setCallback(event.target.value)}
              placeholder={started.redirect_uri}
              width="100%"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <div className="row" style={{ gap: 10 }}>
            <Button loading={busy} disabled={busy || !callback.trim()} onClick={finish}>
              Finish sign-in
            </Button>
            <Button variant="ghost" onClick={() => setStarted(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {problem ? (
        <span className="models-result" data-tone="err" role="alert">
          <Icon name="circleX" size={16} />
          {problem}
        </span>
      ) : null}
      {state?.state === 'signed_in' ? (
        <>
          <ModelChoice
            value={model}
            onChange={setModel}
            options={[]}
            placeholder="The model id, as ChatGPT names it"
          />
          <div className="row" style={{ gap: 10 }}>
            <Button disabled={busy || !model.trim()} onClick={use} iconRight="chevronRight">
              Use this model
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Settings › Models: the active model, then connecting one. */
export function ModelsTab({ loaded }: { loaded: Loaded<ModelSettings> }) {
  const settings = loaded.data;
  return (
    <div className="col" style={{ gap: 14 }}>
      <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 560 }}>
        The model every agent answers with. A change applies from the next reply.
      </p>
      {loaded.error ? <p style={{ color: 'var(--danger)', fontSize: 13 }}>{loaded.error}</p> : null}
      {settings ? (
        <>
          <ActiveModel settings={settings} onChanged={loaded.set} />
          {settings.can_edit ? (
            <ModelConnect settings={settings} onChanged={loaded.set} />
          ) : (
            <p className="models-hint">
              Only the owner of this installation can change the model or its keys.
            </p>
          )}
        </>
      ) : null}
    </div>
  );
}
