/**
 * The card that asks once how much the agent does on its own for a kind of
 * task, the first time it is about to do one. The choice shown is the one
 * the work goes on with; nothing waits for an answer. Picking another keeps it
 * for every later task of this kind, as Settings → Approvals does.
 */
import { useState } from 'react';
import { adapter } from '../experience/adapter.ts';
import type { AutonomyAsk, AutonomyLevel } from '../experience/types.ts';
import { toast } from '../shell/Shell.tsx';

export function AutonomyAskCard({ ask }: { ask: AutonomyAsk }) {
  // What the person picked here, until the stream's copy of the card says so too.
  const [picked, setPicked] = useState<AutonomyLevel | null>(null);
  const [saving, setSaving] = useState(false);
  const level = picked ?? ask.level;
  const chosen = picked ?? ask.chosen;
  const choose = (next: AutonomyLevel) => {
    const before = picked;
    setPicked(next);
    setSaving(true);
    void adapter.saveAutonomy({ task: ask.task, level: next, from: 'card' }).then((result) => {
      setSaving(false);
      if (result.data === null) {
        setPicked(before);
        toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t save that' });
      }
    });
  };
  const name = `autonomy-${ask.id}`;
  return (
    <fieldset className="question autonomy-ask" aria-describedby={`${name}-why`}>
      <legend className="autonomy-ask-title">{ask.title}</legend>
      <p id={`${name}-why`} className="autonomy-ask-why">
        {ask.explanation}
      </p>
      {ask.choices.map((choice) => (
        <label key={choice.level} className="question-option autonomy-ask-option">
          <input
            type="radio"
            className="radio"
            name={name}
            value={choice.level}
            checked={level === choice.level}
            onChange={() => choose(choice.level)}
          />
          <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
            <span className="autonomy-ask-label">{choice.label}</span>
            <span className="autonomy-ask-means">{choice.means}</span>
          </span>
        </label>
      ))}
      <p className="autonomy-ask-foot" aria-live="polite">
        {saving
          ? 'Saving…'
          : chosen
            ? 'Kept for next time. You can change it in Settings → Approvals.'
            : 'You can change it later in Settings → Approvals.'}
      </p>
    </fieldset>
  );
}
