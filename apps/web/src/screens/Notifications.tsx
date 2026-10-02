/**
 * When Melete may reach a person's phone: which devices, what it tells them,
 * how often, and the quiet hours, which are their day hours read the other way
 * round. The offer to turn pushes on appears once, after the first moment
 * Melete was worth hearing from, never on a first visit.
 */
import { useEffect, useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { Button, Input, Select, Toggle } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { useApp, useLoad } from '../experience/hooks.ts';
import {
  dismissOffer,
  enablePush,
  forgetThisBrowser,
  MOMENT_EVENT,
  offerDismissed,
  pushSupported,
  subscribedHere,
  thisBrowserHash,
  thisDeviceSubscribed,
  valueMomentReached,
} from '../experience/push.ts';
import type { PushDevice, PushSettings } from '../experience/types.ts';
import { toast } from '../shell/Shell.tsx';

export const CAP_OPTIONS = [1, 2, 3, 4, 6, 8, 12].map((n) => ({
  value: String(n),
  label: n === 1 ? 'One a day at most' : `${n} a day at most`,
}));

export const BATCH_OPTIONS = [0, 5, 10, 30, 60].map((n) => ({
  value: String(n),
  label: n === 0 ? 'Each one as it comes' : `Within ${n} minutes`,
}));

/** Quiet hours in words, from the settings the service read off the profile. */
export function quietLine(settings: PushSettings): string {
  const { from, until, time_zone } = settings.quiet_hours;
  return `Nothing is sent from ${from} until ${until} (${time_zone}), outside your day.`;
}

const dateOf = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export function deviceLine(device: PushDevice): string {
  return `Added ${dateOf(device.created_at)}${
    device.last_used_at ? ` · last push ${dateOf(device.last_used_at)}` : ' · nothing sent yet'
  }`;
}

function Row({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div
      className="list-row"
      style={{ minHeight: 60, flexWrap: 'wrap', rowGap: 8, paddingTop: 10, paddingBottom: 10 }}
    >
      <div className="col grow" style={{ gap: 2, minWidth: 200 }}>
        <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}>{title}</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{sub}</span>
      </div>
      {children}
    </div>
  );
}

export function NotificationsTab() {
  const { profile, refreshProfile } = useApp();
  const key = useLoad(() => adapter.pushPublicKey(), []);
  const devices = useLoad(() => adapter.pushDevices(), []);
  const settings = useLoad(() => adapter.pushSettings(), []);
  // This browser's subscription, by the hash the service lists it under; undefined until read.
  const [browserHash, setBrowserHash] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [dayStart, setDayStart] = useState(profile?.day_hours.start ?? '08:00');
  const [dayEnd, setDayEnd] = useState(profile?.day_hours.end ?? '22:00');

  useEffect(() => {
    void thisBrowserHash().then(setBrowserHash);
  }, []);

  const configured = Boolean(key.data?.public_key);
  const list = devices.data?.subscriptions ?? [];
  const here =
    browserHash === undefined || !devices.data ? null : subscribedHere(browserHash, list);
  const current = settings.data?.settings;

  const save = async (patch: Parameters<typeof adapter.savePushSettings>[0]) => {
    const r = await adapter.savePushSettings(patch);
    if (r.data === null) {
      toast({ kind: 'err', title: r.error ?? r.unavailable ?? 'Couldn’t save that' });
      return;
    }
    settings.set(r.data);
  };

  const turnOn = async () => {
    setBusy(true);
    const result = await enablePush();
    setBusy(false);
    if (!result.ok) {
      toast({ kind: 'err', title: result.message });
      return;
    }
    setBrowserHash(await thisBrowserHash());
    devices.reload();
    toast({ kind: 'ok', title: 'Pushes are on for this device' });
  };

  const remove = async (device: PushDevice) => {
    const r = await adapter.removePushDevice(device.id);
    if (r.data === null) {
      toast({ kind: 'err', title: r.error ?? r.unavailable ?? 'Couldn’t remove it' });
      return;
    }
    // If it was this browser, it forgets the subscription too, so it can subscribe again.
    if (browserHash && device.endpoint_hash === browserHash) {
      await forgetThisBrowser();
      setBrowserHash(null);
    }
    devices.set({ subscriptions: list.filter((d) => d.id !== device.id) });
    toast({ kind: 'ok', title: `No more pushes to ${device.device_label || 'that device'}` });
  };

  const saveDay = async () => {
    if (!profile) return;
    const r = await adapter.saveProfile({
      name: profile.name,
      time_zone: profile.time_zone,
      day_hours: { start: dayStart, end: dayEnd },
    });
    if (r.data === null) {
      toast({ kind: 'err', title: r.error ?? r.unavailable ?? 'Couldn’t save your day' });
      return;
    }
    refreshProfile();
    settings.reload();
    toast({ kind: 'ok', title: 'Your day is saved', sub: 'Quiet hours follow it.' });
  };

  return (
    <div className="col" style={{ gap: 12 }}>
      <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 560 }}>
        Melete pushes to your phone when a decision is waiting or a chase settles. It stays quiet
        outside your day, groups what arrives together, and says why it sent each one.
      </p>

      {key.data && !configured ? (
        <p style={{ fontSize: 13, color: 'var(--muted)' }}>
          Pushes aren’t set up on this installation yet.
        </p>
      ) : null}

      <div className="card-12" style={{ overflow: 'hidden' }}>
        <div style={{ height: 1 }} />
        <Row
          title="This device"
          sub={
            !pushSupported()
              ? 'This browser can’t receive pushes. On an iPhone, add Melete to your Home Screen first.'
              : here
                ? 'Pushes arrive here.'
                : 'Pushes don’t arrive here yet.'
          }
        >
          {pushSupported() && configured && !here ? (
            <Button icon="bell" loading={busy} disabled={busy} onClick={() => void turnOn()}>
              Turn on here
            </Button>
          ) : null}
        </Row>
        {list.map((device) => (
          <Row key={device.id} title={device.device_label || 'A device'} sub={deviceLine(device)}>
            <Button
              size="sm"
              variant="outline"
              aria-label={`Remove ${device.device_label || 'this device'}`}
              onClick={() => void remove(device)}
            >
              Remove
            </Button>
          </Row>
        ))}
      </div>

      {current ? (
        <>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--heading)', marginTop: 8 }}>
            What to send
          </span>
          <div className="card-12" style={{ overflow: 'hidden' }}>
            <div style={{ height: 1 }} />
            <Row title="A decision is waiting" sub="Something can’t go on until you say.">
              <Toggle
                on={current.decisions}
                label="A decision is waiting"
                onChange={(next) => void save({ decisions: next })}
              />
            </Row>
            <Row title="A chase settled" sub="Money came back, or a company did what it said.">
              <Toggle
                on={current.settled}
                label="A chase settled"
                onChange={(next) => void save({ settled: next })}
              />
            </Row>
            <Row
              title="What came back this week"
              sub="On Mondays: what settled and which replies arrived."
            >
              <Toggle
                on={current.weekly_summary}
                label="What came back this week"
                onChange={(next) => void save({ weekly_summary: next })}
              />
            </Row>
          </div>

          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--heading)', marginTop: 8 }}>
            How often
          </span>
          <div className="card-12" style={{ overflow: 'hidden' }}>
            <div style={{ height: 1 }} />
            <Row title="Daily limit" sub="What’s held back goes into the next push.">
              <Select
                label="Daily limit"
                value={String(current.daily_cap)}
                options={CAP_OPTIONS}
                width={200}
                onChange={(value) => void save({ daily_cap: Number(value) })}
              />
            </Row>
            <Row title="Grouping" sub="Several things close together arrive as one push.">
              <Select
                label="Grouping"
                value={String(current.batch_minutes)}
                options={BATCH_OPTIONS}
                width={260}
                onChange={(value) => void save({ batch_minutes: Number(value) })}
              />
            </Row>
            <Row title="Quiet hours" sub={quietLine(current)}>
              <form
                className="row"
                style={{ gap: 8, flexWrap: 'wrap' }}
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveDay();
                }}
              >
                <Input
                  type="time"
                  aria-label="Your day starts"
                  value={dayStart}
                  onChange={(event) => setDayStart(event.target.value)}
                  width={120}
                />
                <Input
                  type="time"
                  aria-label="Your day ends"
                  value={dayEnd}
                  onChange={(event) => setDayEnd(event.target.value)}
                  width={120}
                />
                <Button size="sm" variant="outline" type="submit">
                  Save your day
                </Button>
              </form>
            </Row>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * The offer on Home, after the first decision or settled chase. It asks once;
 * "Not now" is remembered in this browser.
 */
export function PushOffer() {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const check = async () => {
      if (!pushSupported() || offerDismissed() || !valueMomentReached()) return;
      if (await thisDeviceSubscribed()) return;
      const key = await adapter.pushPublicKey();
      if (key.data?.public_key) setShow(true);
    };
    void check();
    const onMoment = () => void check();
    window.addEventListener(MOMENT_EVENT, onMoment);
    return () => window.removeEventListener(MOMENT_EVENT, onMoment);
  }, []);

  if (!show) return null;
  return (
    <section
      className="card-12 row"
      aria-label="Pushes to your phone"
      style={{ gap: 12, padding: '12px 16px', flexWrap: 'wrap', marginTop: 16 }}
    >
      <span
        className="row"
        style={{
          justifyContent: 'center',
          width: 32,
          height: 32,
          borderRadius: 8,
          background: 'var(--blue-soft)',
          color: 'var(--blue-ink)',
          flexShrink: 0,
        }}
      >
        <Icon name="bell" size={16} />
      </span>
      <div className="col grow" style={{ gap: 2, minWidth: 200 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--heading)' }}>
          Get a nudge when something needs you
        </span>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>
          One push when a decision is waiting or a chase settles. Only during your day, a few a day
          at most.
        </span>
      </div>
      <div className="row" style={{ gap: 6 }}>
        <Button
          size="sm"
          icon="bell"
          loading={busy}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const result = await enablePush();
            setBusy(false);
            if (!result.ok) {
              toast({ kind: 'err', title: result.message });
              return;
            }
            setShow(false);
            toast({ kind: 'ok', title: 'Pushes are on for this device' });
          }}
        >
          Turn on
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            dismissOffer();
            setShow(false);
          }}
        >
          Not now
        </Button>
      </div>
    </section>
  );
}
