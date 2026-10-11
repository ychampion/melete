/**
 * Home's first steps: until the person has a calendar connected and a morning
 * brief set up, one quiet row offers each, with the thing to press. "Not now"
 * puts a row away on this browser; doing the step puts it away everywhere.
 */
import { useEffect, useState } from 'react';
import { Icon, type IconName } from '../design/icons.tsx';
import { Button } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import type { Automation } from '../experience/types.ts';
import { navigate } from '../router.ts';
import { toast } from '../shell/Shell.tsx';
import {
  BRIEF_DEFAULT_AT,
  clockWords,
  endedMorningBrief,
  hasMorningBrief,
} from './MorningBrief.tsx';
import './first-run.css';

export type FirstStep = 'calendar' | 'brief';

const KEY: Record<FirstStep, string> = {
  // The calendar row took over from the connect-apps hint, and keeps its dismissal.
  calendar: 'melete.connect-apps.dismissed',
  brief: 'melete.first-steps.brief.dismissed',
};

function putAway(step: FirstStep): boolean {
  try {
    return window.localStorage.getItem(KEY[step]) !== null;
  } catch {
    return false;
  }
}

function dismiss(step: FirstStep) {
  try {
    window.localStorage.setItem(KEY[step], new Date().toISOString());
  } catch {
    // Storage blocked: the row comes back next time, which is all that is lost.
  }
}

/**
 * Which rows to show. `null` is not known yet, and a row waits for its answer,
 * so nothing appears and then vanishes while the page loads.
 */
export function firstSteps(state: {
  calendar: boolean | null;
  brief: boolean | null;
  dismissed: ReadonlySet<FirstStep>;
}): FirstStep[] {
  const steps: FirstStep[] = [];
  if (state.calendar === false && !state.dismissed.has('calendar')) steps.push('calendar');
  if (state.brief === false && !state.dismissed.has('brief')) steps.push('brief');
  return steps;
}

const ROW: Record<FirstStep, { icon: IconName; title: string; note: string }> = {
  calendar: {
    icon: 'calendar',
    title: 'Connect your calendar so I can watch for conflicts',
    note: 'Your mail and apps too. I look things up there, and ask you before I send, post or pay for anything.',
  },
  brief: {
    icon: 'sun',
    title: 'Set up a morning brief',
    note: `The weather, your day, what needs you and a few lines of news, every morning at ${clockWords(BRIEF_DEFAULT_AT)}.`,
  },
};

/** The brief row when a brief already ended: start that one again. */
const RESTART_BRIEF = {
  icon: 'sun' as IconName,
  title: 'Start your morning brief again',
  note: 'It stopped. Start it again and it comes every morning at its usual time.',
};

export function FirstSteps({ calendar }: { calendar: boolean | null }) {
  const [brief, setBrief] = useState<boolean | null>(null);
  const [ended, setEnded] = useState<Automation | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<FirstStep>>(
    () => new Set((['calendar', 'brief'] as const).filter(putAway)),
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (dismissed.has('brief')) return;
    let live = true;
    void adapter.automations().then((result) => {
      // An instance without routines has no brief to offer.
      if (live && result.data) {
        setBrief(hasMorningBrief(result.data.automations));
        setEnded(endedMorningBrief(result.data.automations));
      }
    });
    return () => {
      live = false;
    };
  }, [dismissed]);

  const steps = firstSteps({ calendar, brief, dismissed });
  if (!steps.length) return null;

  const putAwayRow = (step: FirstStep) => {
    dismiss(step);
    setDismissed((previous) => new Set(previous).add(step));
  };
  const restartBrief = async (stopped: Automation) => {
    if (busy) return;
    setBusy(true);
    const restarted = await adapter.restartAutomation(stopped.id);
    setBusy(false);
    if (restarted.data === null) {
      toast({
        kind: 'err',
        title: 'Couldn’t start the brief again',
        sub: restarted.error ?? restarted.unavailable ?? '',
      });
      return;
    }
    setBrief(true);
    toast({
      kind: 'ok',
      title: 'Your morning brief is on again',
      sub: 'It comes at its usual time. It’s on Automations, where you can pause it.',
    });
  };
  const setUpBrief = async () => {
    if (busy) return;
    if (ended) return restartBrief(ended);
    setBusy(true);
    const made = await adapter.morningBrief({ at: BRIEF_DEFAULT_AT });
    setBusy(false);
    if (made.data === null) {
      toast({
        kind: 'err',
        title: 'Couldn’t set up the brief',
        sub: made.error ?? made.unavailable ?? '',
      });
      return;
    }
    setBrief(true);
    toast({
      kind: 'ok',
      title: `Your morning brief comes at ${clockWords(BRIEF_DEFAULT_AT)}`,
      sub: 'It’s on Automations, where you can pause it.',
    });
  };

  return (
    <section className="first-steps" aria-label="Next steps">
      {steps.map((step) => {
        const row = step === 'brief' && ended ? RESTART_BRIEF : ROW[step];
        return (
          <div key={step} className="card-12 first-step">
            <span className="first-step-mark" aria-hidden="true">
              <Icon name={row.icon} size={16} />
            </span>
            <div className="first-step-text">
              <span className="first-step-title">{row.title}</span>
              <span className="first-step-note">{row.note}</span>
            </div>
            <div className="first-step-actions">
              {step === 'calendar' ? (
                <Button size="sm" icon="calendar" onClick={() => navigate('/settings/connections')}>
                  Connect calendar
                </Button>
              ) : (
                <Button size="sm" icon="sun" loading={busy} onClick={() => void setUpBrief()}>
                  {ended ? 'Start it again' : 'Set it up'}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => putAwayRow(step)}>
                Not now
              </Button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
