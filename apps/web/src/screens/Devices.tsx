/**
 * Settings → Devices: the person's own computers. Each one runs the small
 * companion program, which connects out to Melete; nothing on the computer
 * listens. Here the person makes a one-time code to pair a computer, sees
 * whether it is online and which folders it shares, changes what it may do,
 * and disconnects it for good.
 *
 * A capability is usable only when both this page and the computer allow it,
 * so each switch here says when the computer itself has it off.
 */
import { useEffect, useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { Badge, Button, Dialog, Toggle } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { useLoad } from '../experience/hooks.ts';
import type { Device, DeviceCapabilities, DevicePairing } from '../experience/types.ts';
import { toast } from '../shell/Shell.tsx';

const CAPABILITIES: { key: keyof DeviceCapabilities; label: string; sub: string }[] = [
  {
    key: 'files',
    label: 'Use files in shared folders',
    sub: 'Only folders chosen on the computer. Saving a file waits for your approval.',
  },
  {
    key: 'commands',
    label: 'Run commands',
    sub: 'Each command waits for your approval, runs with a time limit, and is logged on the computer.',
  },
  {
    key: 'browser',
    label: 'Use my browser, signed in as me',
    sub: 'Through the Melete extension you switch on in Chrome, Edge or Brave. Clicks and typing wait for your approval; passwords are never typed or read.',
  },
  { key: 'open_url', label: 'Open web pages', sub: 'In the computer’s default browser.' },
  { key: 'screenshot', label: 'Take screenshots', sub: 'Of the computer’s screen.' },
];

const DEFAULTS: DeviceCapabilities = {
  commands: false,
  files: true,
  open_url: true,
  screenshot: false,
  browser: false,
};

const PLATFORM: Record<Device['platform'], string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  other: 'Computer',
};

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : null;

/** The command a person runs on the computer, with this page's own address and the code. */
const pairCommand = (code: string) =>
  `bun packages/device/src/cli.ts pair --url ${window.location.origin} --code ${code}`;

function Copyable({ text, label }: { text: string; label: string }) {
  return (
    <div
      className="row"
      style={{
        gap: 8,
        padding: '8px 8px 8px 12px',
        borderRadius: 10,
        background: 'var(--soft)',
        alignItems: 'center',
      }}
    >
      <code
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 12,
          overflowWrap: 'anywhere',
          color: 'var(--text)',
        }}
      >
        {text}
      </code>
      <Button
        size="sm"
        variant="ghost"
        icon="copy"
        onClick={() =>
          void navigator.clipboard
            ?.writeText(text)
            .then(() => toast({ kind: 'ok', title: `${label} copied` }))
            .catch(() => toast({ kind: 'err', title: 'Couldn’t copy; select it instead' }))
        }
      >
        Copy
      </Button>
    </div>
  );
}

function PairDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [capabilities, setCapabilities] = useState<DeviceCapabilities>(DEFAULTS);
  const [pairing, setPairing] = useState<DevicePairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairing]);

  const close = () => {
    setPairing(null);
    setCapabilities(DEFAULTS);
    onClose();
  };
  const left = pairing ? Math.max(0, Date.parse(pairing.expires_at) - now) : 0;
  const expired = pairing !== null && left === 0;

  return (
    <Dialog
      open={open}
      onClose={close}
      title={pairing ? 'Pair with this code' : 'Connect a computer'}
      width={520}
      sub={
        pairing
          ? 'Run the companion on the computer and enter this code. It works once.'
          : 'Choose what your agent may do on it. You can change this later, and the computer can turn things off on its own side too.'
      }
      footer={
        pairing ? (
          <Button onClick={close}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void adapter.pairDevice(capabilities).then((r) => {
                  setBusy(false);
                  if (r.data === null) {
                    toast({
                      kind: 'err',
                      title: r.error ?? r.unavailable ?? 'Couldn’t make a code',
                    });
                    return;
                  }
                  setNow(Date.now());
                  setPairing(r.data);
                });
              }}
            >
              Make a code
            </Button>
          </>
        )
      }
    >
      {pairing ? (
        <div className="col" style={{ gap: 14 }}>
          <div className="col" style={{ gap: 4, alignItems: 'center', padding: '8px 0' }}>
            <span
              data-testid="pairing-code"
              style={{
                fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                fontSize: 30,
                fontWeight: 600,
                letterSpacing: '0.12em',
                color: expired ? 'var(--muted)' : 'var(--heading)',
                textDecoration: expired ? 'line-through' : undefined,
              }}
            >
              {pairing.code}
            </span>
            <span style={{ fontSize: 12, color: expired ? 'var(--danger)' : 'var(--muted)' }}>
              {expired
                ? 'This code expired. Close this and make a new one.'
                : `Expires in ${Math.floor(left / 60_000)}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, '0')}`}
            </span>
          </div>
          <div className="col" style={{ gap: 6 }}>
            <span style={{ fontSize: 13, color: 'var(--secondary)' }}>
              On the computer, from a copy of Melete with Bun installed:
            </span>
            <Copyable text={pairCommand(pairing.code)} label="Command" />
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              It asks which folders to share and what to allow, then stays connected. It only
              connects out to this address; nothing on the computer opens a port.
            </span>
          </div>
        </div>
      ) : (
        <div className="col" style={{ gap: 10 }}>
          {CAPABILITIES.map((item) => (
            <div key={item.key} className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
              <div className="col grow" style={{ gap: 2 }}>
                <span style={{ fontSize: 14, color: 'var(--heading)' }}>{item.label}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{item.sub}</span>
              </div>
              <Toggle
                label={item.label}
                on={capabilities[item.key]}
                onChange={(next) => setCapabilities({ ...capabilities, [item.key]: next })}
              />
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

export function DeviceCard({
  device,
  onChanged,
  screensByDefault,
}: {
  device: Device;
  onChanged: () => void;
  /** Settings → Privacy's answer for paired computers, which this one follows unless it says otherwise. */
  screensByDefault: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState<keyof DeviceCapabilities | 'screens' | null>(null);
  const [removing, setRemoving] = useState(false);
  const revoked = device.status === 'revoked';
  // Only a computer already disconnected comes off the list; what it did stays in Activity.
  const remove = () => {
    setRemoving(true);
    void adapter.removeDevice(device.id).then((r) => {
      setRemoving(false);
      if (r.data === null) {
        toast({ kind: 'err', title: r.error ?? r.unavailable ?? 'Couldn’t remove it' });
        return;
      }
      toast({ kind: 'ok', title: `${device.name} is removed` });
      onChanged();
    });
  };
  const status =
    device.status === 'online' ? (
      <Badge tone="success" dot>
        Online
      </Badge>
    ) : device.status === 'offline' ? (
      <Badge tone="outline">Offline</Badge>
    ) : (
      <Badge tone="danger" dot>
        Disconnected
      </Badge>
    );
  const seen = when(device.last_seen_at);

  return (
    <div className="card-12 col" style={{ gap: 12, padding: 14 }}>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <span
          className="row"
          style={{
            justifyContent: 'center',
            width: 40,
            height: 40,
            borderRadius: 10,
            background: 'var(--blue-soft)',
            color: 'var(--blue-ink)',
            flexShrink: 0,
          }}
        >
          <Icon name="laptop" size={20} />
        </span>
        <div className="col grow" style={{ gap: 2, minWidth: 160 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--heading)' }}>
            {device.name}
          </span>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {PLATFORM[device.platform]}
            {revoked
              ? ` · disconnected ${when(device.revoked_at) ?? ''}`
              : seen
                ? ` · last seen ${seen}`
                : ''}
          </span>
        </div>
        {status}
        {device.browser_connected ? (
          <Badge tone="success" dot>
            Browser connected
          </Badge>
        ) : null}
        {revoked ? (
          <Button
            size="sm"
            variant="ghost"
            loading={removing}
            aria-label={`Remove ${device.name}`}
            onClick={remove}
          >
            Remove
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
            Disconnect
          </Button>
        )}
      </div>
      {revoked ? null : (
        <>
          <div className="col" style={{ gap: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--secondary)' }}>
              Shared folders
            </span>
            {device.folders.length ? (
              device.folders.map((folder) => (
                <span
                  key={folder.name}
                  style={{ fontSize: 13, color: 'var(--text)', overflowWrap: 'anywhere' }}
                >
                  <strong style={{ fontWeight: 600 }}>{folder.name}</strong>{' '}
                  <span style={{ color: 'var(--muted)' }}>{folder.path}</span>
                </span>
              ))
            ) : (
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                None. Add one on the computer with “melete-device folders add”.
              </span>
            )}
          </div>
          <div className="col" style={{ gap: 8 }}>
            {CAPABILITIES.map((item) => {
              const offThere = !device.local_capabilities[item.key];
              return (
                <div key={item.key} className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                  <div className="col grow" style={{ gap: 2 }}>
                    <span style={{ fontSize: 13, color: 'var(--heading)' }}>{item.label}</span>
                    {offThere ? (
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                        Turned off on the computer itself
                      </span>
                    ) : null}
                  </div>
                  <Toggle
                    label={`${item.label} on ${device.name}`}
                    on={device.capabilities[item.key]}
                    disabled={saving !== null}
                    onChange={(next) => {
                      setSaving(item.key);
                      void adapter.changeDevice(device.id, { [item.key]: next }).then((r) => {
                        setSaving(null);
                        if (r.data === null) {
                          toast({
                            kind: 'err',
                            title: r.error ?? r.unavailable ?? 'Couldn’t change that',
                          });
                          return;
                        }
                        onChanged();
                      });
                    }}
                  />
                </div>
              );
            })}
            <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
              <div className="col grow" style={{ gap: 2 }}>
                <span style={{ fontSize: 13, color: 'var(--heading)' }}>
                  Let cloud models see this screen
                </span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {device.cloud_screenshots === null
                    ? 'Follows Settings → Privacy. Screenshots are never redacted.'
                    : 'Set for this computer. Screenshots are never redacted.'}
                </span>
              </div>
              <Toggle
                label={`Let cloud models see the screen of ${device.name}`}
                on={device.cloud_screenshots ?? screensByDefault}
                disabled={saving !== null}
                onChange={(next) => {
                  setSaving('screens');
                  void adapter.changeDeviceScreens(device.id, next).then((r) => {
                    setSaving(null);
                    if (r.data === null) {
                      toast({
                        kind: 'err',
                        title: r.error ?? r.unavailable ?? 'Couldn’t change that',
                      });
                      return;
                    }
                    onChanged();
                  });
                }}
              />
            </div>
          </div>
        </>
      )}
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        icon="trash"
        tone="danger"
        title={`Disconnect ${device.name}?`}
        sub="Its token stops working at once and anything waiting for it is cancelled. To use it again, pair it with a new code."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                void adapter.revokeDevice(device.id).then((r) => {
                  setConfirming(false);
                  if (r.data === null) {
                    toast({
                      kind: 'err',
                      title: r.error ?? r.unavailable ?? 'Couldn’t disconnect',
                    });
                    return;
                  }
                  toast({ kind: 'ok', title: `${device.name} is disconnected` });
                  onChanged();
                })
              }
            >
              Disconnect
            </Button>
          </>
        }
      />
    </div>
  );
}

export function DevicesTab({ onCount }: { onCount?: (count: number) => void }) {
  const devices = useLoad(() => adapter.devices(), []);
  // Only to show what a computer with no answer of its own follows: off unless turned on.
  const privacy = useLoad(() => adapter.privacySettings(), []);
  const [pairing, setPairing] = useState(false);
  const list = devices.data?.devices ?? [];
  const active = list.filter((device) => device.status !== 'revoked');
  const shown = [...active, ...list.filter((device) => device.status === 'revoked').slice(0, 3)];
  const reload = devices.reload;

  useEffect(() => {
    onCount?.(active.length);
  }, [active.length, onCount]);

  // Online and offline change on their own, so the list is read again now and then.
  useEffect(() => {
    const timer = setInterval(reload, 10_000);
    return () => clearInterval(timer);
  }, [reload]);

  return (
    <div className="col" style={{ gap: 12 }}>
      <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 600 }}>
        Let your agent use your own computer alongside its own. A small companion program on the
        computer connects out to Melete, uses only the folders you choose there, and asks you before
        it runs a command or changes a file.
      </p>
      {devices.error ? (
        <p style={{ color: 'var(--danger)', fontSize: 13 }}>{devices.error}</p>
      ) : null}
      <div className="col" style={{ gap: 8 }}>
        {shown.map((device) => (
          <DeviceCard
            key={device.id}
            device={device}
            onChanged={reload}
            screensByDefault={privacy.data?.screenshots_paired_devices ?? false}
          />
        ))}
      </div>
      {devices.data && active.length === 0 ? (
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>
          {shown.length ? 'None connected right now.' : 'No computer is connected yet.'}
        </span>
      ) : null}
      <div>
        <Button icon="plus" onClick={() => setPairing(true)}>
          Connect a computer
        </Button>
      </div>
      <PairDialog
        open={pairing}
        onClose={() => {
          setPairing(false);
          reload();
        }}
      />
    </div>
  );
}
