/**
 * What a list shows when it could not be read: what failed, the service's
 * reason, and a way to try again. Never an empty state, which would say the
 * person's data is gone.
 */
import { Icon } from './icons.tsx';
import { Button } from './primitives.tsx';

export function LoadError({
  what,
  error,
  onRetry,
  compact = false,
}: {
  /** What could not be loaded, as the end of "Couldn’t load …". */
  what: string;
  error: string;
  onRetry: () => void;
  /** A one-line version for narrow places such as the sidebar. */
  compact?: boolean;
}) {
  return (
    <div
      role="alert"
      className={compact ? 'col' : 'row'}
      style={{
        gap: compact ? 6 : 10,
        alignItems: compact ? 'flex-start' : 'center',
        flexWrap: 'wrap',
        padding: compact ? '6px 10px' : '10px 12px',
        borderRadius: 10,
        background: 'var(--sand)',
        color: 'var(--sand-ink)',
        fontSize: 13,
      }}
    >
      <span className="row" style={{ gap: 8, minWidth: 0, flex: compact ? undefined : 1 }}>
        <Icon name="info" size={14} />
        <span style={{ minWidth: 0 }}>
          Couldn’t load {what}.{compact ? null : ` ${error}`}
        </span>
      </span>
      <Button size="sm" variant="outline" icon="refresh" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
