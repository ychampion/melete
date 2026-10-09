/**
 * What long work asked the person's OK for, answered where the work is shown:
 * its own page and its card in the conversation that started it. The
 * permissions are the ones Home's queue holds; the work's own and its
 * helpers' are matched by the job each belongs to.
 */
import { useEffect } from 'react';
import { Button } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { useInFlight } from '../experience/decide.ts';
import { useApp } from '../experience/hooks.ts';
import type { Permission, Run } from '../experience/types.ts';
import { toast } from '../shell/Shell.tsx';

/** The open permissions asked by this work or one of its helpers, oldest first. */
export function permissionsFor(
  run: Pick<Run, 'id' | 'steps'>,
  permissions: readonly Permission[],
): Permission[] {
  const jobs = new Set([run.id, ...run.steps.map((step) => step.id)]);
  return permissions
    .filter((permission) => permission.conversation_id && jobs.has(permission.conversation_id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** The work a permission was asked by, when it was asked by long work in this list. */
export function runOfPermission<T extends Pick<Run, 'id' | 'steps'>>(
  runs: readonly T[],
  permission: Pick<Permission, 'conversation_id'>,
): T | null {
  const id = permission.conversation_id;
  if (!id) return null;
  return runs.find((run) => run.id === id || run.steps.some((step) => step.id === id)) ?? null;
}

/** The facts worth reading before answering: what will happen, exactly. */
const FACTS = ['Command', 'Runs in', 'File', 'Page', 'Network', 'Title', 'Element', 'Text', 'Then'];

export function RunPermissions({
  run,
  compact = false,
  onDecided,
}: {
  run: Pick<Run, 'id' | 'steps' | 'status'>;
  /** In a chat card: the ask and its two buttons, without the details. */
  compact?: boolean;
  onDecided?: () => void;
}) {
  const { decisions, refreshConversations } = useApp();
  const flight = useInFlight();
  const asked = permissionsFor(run, decisions.permissions);
  // Work that turned to waiting on the person is read again, so its ask shows.
  useEffect(() => {
    if (run.status === 'needs_you') refreshConversations();
  }, [run.status, refreshConversations]);
  if (!asked.length) return null;
  const decide = (permission: Permission, option: 'allow_once' | 'deny') =>
    void flight.run(permission.id, async () => {
      const result = await adapter.decide(permission.id, option, permission.version);
      if (result.data === null) {
        toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t decide' });
        return;
      }
      toast({
        kind: 'info',
        title: option === 'deny' ? 'Declined' : 'Approved',
        sub: option === 'deny' ? 'It goes on without it.' : 'It goes on from here.',
      });
      refreshConversations();
      onDecided?.();
    });
  return (
    <ul className="run-permissions">
      {asked.map((permission) => {
        const facts = compact
          ? []
          : (permission.preview?.facts ?? []).filter((fact) => FACTS.includes(fact.label));
        const busy = flight.has(permission.id);
        return (
          <li key={permission.id} className="run-permission">
            <span className="run-permission-what">{permission.what}</span>
            {!compact && permission.why[0] ? (
              <span className="run-permission-why">{permission.why[0]}</span>
            ) : null}
            {facts.map((fact) => (
              <span key={fact.label} className="run-permission-why">
                {fact.label}: <code>{fact.value}</code>
              </span>
            ))}
            <span className="run-permission-actions">
              {permission.options.includes('allow_once') ? (
                <Button
                  size="sm"
                  disabled={busy}
                  aria-label={`Approve: ${permission.what}`}
                  onClick={() => decide(permission, 'allow_once')}
                >
                  Approve
                </Button>
              ) : null}
              {permission.options.includes('deny') ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  aria-label={`Decline: ${permission.what}`}
                  onClick={() => decide(permission, 'deny')}
                >
                  Decline
                </Button>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
