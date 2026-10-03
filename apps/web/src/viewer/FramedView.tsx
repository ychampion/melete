/**
 * Someone else's page, framed inside Melete.
 *
 * The frame is sandboxed without `allow-same-origin`, and the page itself is
 * served with `Content-Security-Policy: sandbox`, so it runs with an opaque
 * origin either way: it cannot read Melete's cookies, storage or API, open
 * windows, or move the page around it. What it may ask for goes through the
 * bridge (apps/bridge.ts), and a link it wants opened is shown to the person
 * first.
 */
import { useEffect, useRef, useState } from 'react';
import { type BridgeHost, connectBridge, notifyChanged } from '../apps/bridge.ts';
import { Button, Dialog } from '../design/primitives.tsx';

/** What the framed page may do. Never same-origin, popups, or top navigation. */
export const FRAME_SANDBOX = 'allow-scripts allow-forms allow-downloads';

export type FrameCalls = Pick<BridgeHost, 'data' | 'submit'>;

export function FramedView({
  src,
  title,
  calls,
  changed = null,
}: {
  src: string;
  /** Names the frame for assistive technology. */
  title: string;
  /** Stable across renders: the bridge reconnects when it changes. */
  calls: FrameCalls;
  /** Data the app read that has a newer version; each new value is told to the app once. */
  changed?: { name: string; at: number } | null;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [link, setLink] = useState<{ url: string; settle: (open: boolean) => void } | null>(null);

  useEffect(
    () =>
      connectBridge(() => frame.current, {
        ...calls,
        resize: setHeight,
        confirmLink: (url) => new Promise((settle) => setLink({ url, settle })),
      }),
    [calls],
  );

  useEffect(() => {
    if (changed) notifyChanged(frame.current, changed.name);
  }, [changed]);

  const answer = (open: boolean) => {
    link?.settle(open);
    setLink(null);
  };

  return (
    <>
      <iframe
        ref={frame}
        className="framed-view"
        src={src}
        title={title}
        sandbox={FRAME_SANDBOX}
        referrerPolicy="no-referrer"
        style={height ? { height, flex: 'none' } : undefined}
      />
      <Dialog
        open={link !== null}
        onClose={() => answer(false)}
        title="Open this link?"
        sub={`${title} wants to open a page on another site, in a new tab.`}
        icon="globe"
        footer={
          <>
            <Button variant="ghost" onClick={() => answer(false)}>
              Cancel
            </Button>
            <Button onClick={() => answer(true)}>Open link</Button>
          </>
        }
      >
        <p className="framed-link">{link?.url}</p>
      </Dialog>
    </>
  );
}
