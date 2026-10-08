/**
 * The first-run hint on Home: until the person connects an app of their own,
 * one quiet card says what connecting does and where. "Not now" puts it away
 * on this browser; connecting anything puts it away everywhere.
 */
import { useEffect, useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { Button } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { navigate } from '../router.ts';
import './connections.css';

const DISMISSED_KEY = 'melete.connect-apps.dismissed';

function dismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) !== null;
  } catch {
    return false;
  }
}

function dismiss() {
  try {
    window.localStorage.setItem(DISMISSED_KEY, new Date().toISOString());
  } catch {
    // Storage blocked: the hint comes back next time, which is all that is lost.
  }
}

export function ConnectAppsHint() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (dismissed()) return;
    let live = true;
    void adapter.connections().then((result) => {
      // Built-in connections are Melete's own; the hint is about the person's apps.
      if (live && result.data && !result.data.connections.some((item) => item.builtin !== true))
        setShow(true);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!show) return null;
  return (
    <section className="card-12 row connect-hint" aria-labelledby="connect-hint-title">
      <span className="connect-hint-mark" aria-hidden="true">
        <Icon name="apps" size={16} />
      </span>
      <div className="col grow" style={{ gap: 2, minWidth: 200 }}>
        <span id="connect-hint-title" className="connect-hint-title">
          Connect your apps
        </span>
        <span className="connect-hint-note">
          Mail, calendar, Notion, Linear, GitHub and more. Melete looks things up there, and asks
          you before it sends, posts or pays for anything.
        </span>
      </div>
      <div className="row" style={{ gap: 6 }}>
        <Button size="sm" icon="apps" onClick={() => navigate('/settings/connections')}>
          Connect apps
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            dismiss();
            setShow(false);
          }}
        >
          Not now
        </Button>
      </div>
    </section>
  );
}
