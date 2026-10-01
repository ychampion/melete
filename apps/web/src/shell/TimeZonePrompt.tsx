/**
 * Asks once which time zone to use, for an account whose zone was never
 * chosen and differs from this browser's. Either answer is kept, so the
 * question does not come back; Settings › Account changes it later.
 */
import { useState } from 'react';
import { Button, Dialog } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { useApp } from '../experience/hooks.ts';
import { browserTimeZone, zoneLabel } from '../experience/timezone.ts';
import { toast } from './Shell.tsx';

export function TimeZonePrompt() {
  const { profile, refreshProfile } = useApp();
  const [busy, setBusy] = useState<'use' | 'keep' | null>(null);
  const [answered, setAnswered] = useState(false);
  const here = browserTimeZone();
  if (!profile || answered || profile.time_zone_confirmed || !here || here === profile.time_zone)
    return null;
  const choose = async (zone: string, which: 'use' | 'keep') => {
    setBusy(which);
    const saved = await adapter.saveProfile({
      name: profile.name,
      time_zone: zone,
      day_hours: profile.day_hours,
      time_zone_confirmed: true,
    });
    setBusy(null);
    if (!saved.data) {
      toast({
        kind: 'err',
        title: 'Couldn’t save your time zone',
        sub: saved.error ?? saved.unavailable ?? '',
      });
      return;
    }
    setAnswered(true);
    refreshProfile();
  };
  return (
    <Dialog
      open
      onClose={() => setAnswered(true)}
      title="Which time zone are you in?"
      sub={`Melete is using ${zoneLabel(profile.time_zone)}, but this browser is in ${zoneLabel(here)}. Routines such as the morning brief run on this clock.`}
      footer={
        <>
          <Button
            variant="ghost"
            loading={busy === 'keep'}
            disabled={busy !== null}
            onClick={() => void choose(profile.time_zone, 'keep')}
          >
            Keep {zoneLabel(profile.time_zone)}
          </Button>
          <Button
            loading={busy === 'use'}
            disabled={busy !== null}
            onClick={() => void choose(here, 'use')}
          >
            Use {zoneLabel(here)}
          </Button>
        </>
      }
    >
      <p style={{ fontSize: 13, color: 'var(--muted)' }}>
        You can change it any time in Settings › Account.
      </p>
    </Dialog>
  );
}
