/**
 * Confirming it is you before a money move.
 *
 * A payment, purchase or transfer is allowed only with the person's own
 * password, typed at that moment: the service checks it and hands back a
 * token that counts once, for that card, for two minutes. A typed "yes" in the
 * chat is never enough, so Allow on a money card opens this first.
 */
import { useCallback, useState } from 'react';
import { Button, Dialog, Field, Input } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import type { Permission } from '../experience/types.ts';

type Asking = { permission: Permission; resolve: (token: string | null) => void };

/**
 * `confirm(permission)` resolves with a token for the card's Allow, or null
 * when the person closed the dialog. Cards that move no money resolve at once
 * with undefined, so callers pass the result straight on.
 */
export function useStepUp() {
  const [asking, setAsking] = useState<Asking | null>(null);
  const confirm = useCallback(
    (permission: Permission): Promise<string | null | undefined> =>
      permission.step_up
        ? new Promise((resolve) => setAsking({ permission, resolve }))
        : Promise.resolve(undefined),
    [],
  );
  const dialog = asking ? (
    <StepUpDialog
      permission={asking.permission}
      onDone={(token) => {
        asking.resolve(token);
        setAsking(null);
      }}
    />
  ) : null;
  return { confirm, dialog };
}

function StepUpDialog({
  permission,
  onDone,
}: {
  permission: Permission;
  onDone: (token: string | null) => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const available = permission.step_up?.available === true;
  const formId = `step-up-${permission.id}`;
  const submit = () => {
    if (!password || busy) return;
    setBusy(true);
    setProblem(null);
    void adapter.stepUp(permission.id, password).then((result) => {
      setBusy(false);
      if (result.data === null) {
        setPassword('');
        setProblem(result.error ?? result.unavailable ?? 'Couldn’t confirm it is you.');
        return;
      }
      onDone(result.data.step_up_token);
    });
  };
  return (
    <Dialog
      open
      onClose={() => onDone(null)}
      icon="lock"
      title="Confirm it’s you"
      sub={
        available
          ? `${permission.what}. This moves money, so enter your password to allow it once.`
          : 'This moves money, so it needs your password. Set one in Settings › Account first.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => onDone(null)}>
            Cancel
          </Button>
          {available ? (
            <Button type="submit" form={formId} loading={busy} disabled={!password}>
              Confirm and allow
            </Button>
          ) : null}
        </>
      }
    >
      {available ? (
        <form
          id={formId}
          className="col"
          style={{ gap: 10 }}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field label="Your password">
            <Input
              type="password"
              aria-label="Your password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              // biome-ignore lint/a11y/noAutofocus: the dialog exists to take this one field
              autoFocus
              width="100%"
            />
          </Field>
          {problem ? (
            <span role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>
              {problem}
            </span>
          ) : null}
        </form>
      ) : null}
    </Dialog>
  );
}
