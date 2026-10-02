/**
 * Settings › Account: the name Melete uses, the time zone routines run on, and
 * the password. Changing the password signs out every other device. Signing
 * out is in the account menu, at the foot of the sidebar.
 */
import { useState } from 'react';
import { Button, Field, Input, Select } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { useApp } from '../experience/hooks.ts';
import { givenName, UNNAMED } from '../experience/profile.ts';
import { browserTimeZone, timeZoneChoices, zoneName } from '../experience/timezone.ts';
import { toast } from '../shell/Shell.tsx';

function TimeZoneField() {
  const { profile, refreshProfile } = useApp();
  const [busy, setBusy] = useState(false);
  if (!profile) return null;
  const here = browserTimeZone();
  const save = async (zone: string) => {
    setBusy(true);
    const saved = await adapter.saveProfile({
      name: profile.name,
      time_zone: zone,
      day_hours: profile.day_hours,
      time_zone_confirmed: true,
    });
    setBusy(false);
    if (!saved.data) {
      toast({
        kind: 'err',
        title: 'Couldn’t change the time zone',
        sub: saved.error ?? saved.unavailable ?? '',
      });
      return;
    }
    refreshProfile();
    toast({
      kind: 'ok',
      title: `Time zone set to ${zoneName(zone)}`,
      sub: 'Routines keep their time of day on this clock.',
    });
  };
  return (
    <div className="col" style={{ gap: 8 }}>
      <Field label="Time zone">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Select
            label="Time zone"
            value={profile.time_zone}
            onChange={(zone) => void save(zone)}
            width="min(100%, 320px)"
            options={timeZoneChoices(profile.time_zone).map((zone) => ({
              value: zone,
              label: zoneName(zone),
            }))}
          />
          {here && here !== profile.time_zone ? (
            <Button variant="outline" size="sm" loading={busy} onClick={() => void save(here)}>
              Use this device’s: {zoneName(here)}
            </Button>
          ) : null}
        </div>
      </Field>
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>
        Routines such as the morning brief run on this clock, through daylight-saving changes.
      </span>
    </div>
  );
}

function NameField() {
  const { profile, refreshProfile } = useApp();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!profile) return null;
  const value = draft ?? givenName(profile);
  const changed = value.trim() !== givenName(profile);
  return (
    <form
      className="col"
      style={{ gap: 8, maxWidth: 360 }}
      onSubmit={(event) => {
        event.preventDefault();
        if (!changed || busy) return;
        setBusy(true);
        void adapter
          .saveProfile({
            name: value.trim() || UNNAMED,
            time_zone: profile.time_zone,
            day_hours: profile.day_hours,
          })
          .then((saved) => {
            setBusy(false);
            if (!saved.data) {
              toast({
                kind: 'err',
                title: 'Couldn’t save your name',
                sub: saved.error ?? saved.unavailable ?? '',
              });
              return;
            }
            setDraft(null);
            refreshProfile();
            toast({ kind: 'ok', title: 'Name saved' });
          });
      }}
    >
      <Field label="Your name" hint="Melete greets you by it.">
        <Input
          value={value}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Your name"
          maxLength={80}
          autoComplete="name"
          width="100%"
        />
      </Field>
      {changed ? (
        <div className="row">
          <Button type="submit" variant="outline" size="sm" loading={busy}>
            Save name
          </Button>
        </div>
      ) : null}
    </form>
  );
}

function PasswordForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      className="col"
      style={{ gap: 10, maxWidth: 360 }}
      onSubmit={(event) => {
        event.preventDefault();
        if (next.length < 8) return setProblem('The new password needs at least 8 characters.');
        if (next !== again) return setProblem('The two new passwords are not the same.');
        setBusy(true);
        setProblem(null);
        void adapter.changePassword(current, next).then((result) => {
          setBusy(false);
          if (result.data === null) {
            setProblem(result.error ?? result.unavailable ?? 'Couldn’t change the password.');
            return;
          }
          setCurrent('');
          setNext('');
          setAgain('');
          toast({
            kind: 'ok',
            title: 'Password changed',
            sub: 'Other devices and connected apps were signed out. This one stays signed in.',
          });
        });
      }}
    >
      <Field label="Current password">
        <Input
          type="password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          autoComplete="current-password"
          width="100%"
        />
      </Field>
      <Field label="New password">
        <Input
          type="password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
          placeholder="At least 8 characters"
          autoComplete="new-password"
          width="100%"
        />
      </Field>
      <Field label="New password again">
        <Input
          type="password"
          value={again}
          onChange={(event) => setAgain(event.target.value)}
          autoComplete="new-password"
          width="100%"
        />
      </Field>
      {problem ? (
        <span role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>
          {problem}
        </span>
      ) : null}
      <div className="row">
        <Button
          type="submit"
          variant="outline"
          loading={busy}
          disabled={!current || !next || !again}
        >
          Change password
        </Button>
      </div>
    </form>
  );
}

export function AccountSettings() {
  return (
    <div className="col" style={{ gap: 20 }}>
      <NameField />
      <TimeZoneField />
      <div className="col" style={{ gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--heading)' }}>Password</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          Forgot it? Sign out and choose “Forgot your password?” on the sign-in page.
        </span>
        <PasswordForm />
      </div>
    </div>
  );
}
