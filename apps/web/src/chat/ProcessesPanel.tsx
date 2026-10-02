/**
 * The background processes in the agent's computer, under the computer view:
 * each one's name, state, how long it has run, its port and the last line it
 * printed. The person whose job started a process can read the end of its
 * output and stop it, and open a preview of the server it runs.
 *
 * A preview is framed with FramedView, sandboxed and served with the app
 * viewer's isolation, so the page runs with an opaque origin: it cannot read
 * Melete's cookies, storage or API, and reaches only that port of that
 * computer. It has no Melete data to ask for.
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { Button, IconButton } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import type { ComputerProcess } from '../experience/types.ts';
import { toast } from '../shell/Shell.tsx';
import { type FrameCalls, FramedView } from '../viewer/FramedView.tsx';
import { previewDue, processLive, processStateWords, runningFor } from './processes.ts';
import './processes.css';

/** A preview has no Melete data: the bridge refuses whatever the page asks for. */
const NO_DATA = async () => ({ ok: false as const, error: 'A preview has no Melete data.' });
const PREVIEW_CALLS: FrameCalls = { data: NO_DATA, submit: NO_DATA };

type Preview = {
  processId: string;
  name: string;
  port: number;
  src: string;
  /** When the preview the frame loaded ends; a new one replaces it before then. */
  expiresAt: string;
  loads: number;
};

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

function ProcessRow({
  process,
  now,
  previewing,
  onPreview,
  onChanged,
}: {
  process: ComputerProcess;
  now: number;
  previewing: boolean;
  onPreview: (process: ComputerProcess) => Promise<void>;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<'preview' | 'stop' | 'output' | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const live = processLive(process.state);
  const started = Date.parse(process.started_at);
  const outputId = `process-output-${process.id}`;

  const stop = async () => {
    setBusy('stop');
    const result = await adapter.processStop(process.id);
    setBusy(null);
    if (result.data === null) {
      toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t stop it' });
      return;
    }
    toast({ kind: 'ok', title: `Stopped ${process.name}` });
    onChanged();
  };

  const readOutput = async () => {
    if (output !== null) {
      setOutput(null);
      return;
    }
    setBusy('output');
    const result = await adapter.processOutput(process.id);
    setBusy(null);
    if (result.data === null) {
      toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t read it' });
      return;
    }
    setOutput(result.data.text || 'Nothing printed yet.');
  };

  const preview = async () => {
    setBusy('preview');
    await onPreview(process);
    setBusy(null);
  };

  return (
    <li className="process-row" data-state={process.state}>
      <div className="process-line">
        <span className="process-dot" aria-hidden="true" />
        <span className="process-name clamp1">{process.name}</span>
        {process.port !== null ? <span className="process-port">:{process.port}</span> : null}
      </div>
      <span className="process-meta">
        {processStateWords(process.state)}
        {live && Number.isFinite(started) ? ` · ${runningFor(now - started)}` : ''}
      </span>
      {process.last_line ? <pre className="process-last">{process.last_line}</pre> : null}
      <div className="process-actions">
        {process.can_preview ? (
          <Button
            size="sm"
            variant={previewing ? 'soft' : 'outline'}
            icon="frame"
            loading={busy === 'preview'}
            disabled={busy !== null}
            aria-pressed={previewing}
            onClick={() => void preview()}
          >
            Preview
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          icon="terminal"
          loading={busy === 'output'}
          disabled={busy !== null && busy !== 'output'}
          aria-expanded={output !== null}
          aria-controls={outputId}
          onClick={() => void readOutput()}
        >
          {output === null ? 'Read output' : 'Hide output'}
        </Button>
        {live ? (
          <Button
            size="sm"
            variant="ghost"
            icon="square"
            loading={busy === 'stop'}
            disabled={busy !== null}
            onClick={() => void stop()}
          >
            Stop
          </Button>
        ) : null}
      </div>
      {output !== null ? (
        <pre id={outputId} className="process-output">
          {output}
        </pre>
      ) : null}
    </li>
  );
}

export function ProcessesPanel({
  processes,
  onChanged,
}: {
  processes: ComputerProcess[];
  /** A process was stopped; the computer is read again. */
  onChanged: () => void;
}) {
  const now = useNow(30_000);
  const [preview, setPreview] = useState<Preview | null>(null);
  const shown = preview ? processes.find((each) => each.id === preview.processId) : undefined;
  // The server a preview showed stopped: the frame has nothing left to load.
  const ended = preview !== null && shown?.state !== 'running';

  const open = async (process: ComputerProcess) => {
    if (preview?.processId === process.id) {
      setPreview(null);
      return;
    }
    const result = await adapter.processPreview(process.id);
    if (result.data === null) {
      toast({
        kind: 'err',
        title: result.error ?? result.unavailable ?? 'Couldn’t open the preview',
      });
      return;
    }
    setPreview({
      processId: process.id,
      name: process.name,
      port: result.data.port,
      src: adapter.previewSource(result.data),
      expiresAt: result.data.expires_at,
      loads: 0,
    });
  };

  // A preview lasts half an hour. While it is on screen, a new one is opened
  // shortly before it ends and the frame loads it; one that cannot be renewed
  // (the server stopped, or the person lost access) closes with a word why.
  const renewing = useRef(false);
  useEffect(() => {
    if (!preview || ended || renewing.current || !previewDue(preview.expiresAt, now)) return;
    renewing.current = true;
    void adapter.processPreview(preview.processId).then((result) => {
      renewing.current = false;
      if (result.data === null) {
        toast({
          kind: 'err',
          title: result.error ?? result.unavailable ?? 'The preview could not be renewed',
        });
        setPreview(null);
        return;
      }
      const renewed = result.data;
      setPreview((current) =>
        current?.processId === renewed.process_id
          ? {
              ...current,
              src: adapter.previewSource(renewed),
              expiresAt: renewed.expires_at,
            }
          : current,
      );
    });
  }, [preview, ended, now]);

  if (processes.length === 0) return null;
  return (
    <>
      <section className="computer-processes" aria-label="Processes">
        <div className="computer-processes-head">
          <Icon name="clock" size={14} />
          Processes
        </div>
        <ul className="process-list">
          {processes.map((process) => (
            <ProcessRow
              key={process.id}
              process={process}
              now={now}
              previewing={preview?.processId === process.id}
              onPreview={open}
              onChanged={onChanged}
            />
          ))}
        </ul>
      </section>
      {preview ? (
        <section className="process-preview" aria-label={`Preview of ${preview.name}`}>
          <div className="process-preview-head">
            <Icon name="frame" size={14} />
            <span className="clamp1">
              {preview.name} <span className="process-port">:{preview.port}</span>
            </span>
            <div className="grow" />
            <IconButton
              name="refresh"
              label="Reload the preview"
              size={28}
              iconSize={14}
              disabled={ended}
              onClick={() => setPreview({ ...preview, loads: preview.loads + 1 })}
            />
            <IconButton
              name="x"
              label="Close the preview"
              size={28}
              iconSize={14}
              onClick={() => setPreview(null)}
            />
          </div>
          {ended ? (
            <p className="process-preview-ended" role="status">
              The server stopped, so there is nothing left to preview.
            </p>
          ) : (
            <FramedView
              key={`${preview.src}#${preview.loads}`}
              src={preview.src}
              title={`Preview of ${preview.name}`}
              calls={PREVIEW_CALLS}
            />
          )}
        </section>
      ) : null}
    </>
  );
}
