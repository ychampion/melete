/**
 * The browser side of talking to Melete.
 *
 * Push-to-talk records with MediaRecorder: tap to start, tap to stop, and the
 * words come back into the message box to be read and sent by hand. Voice mode
 * streams the microphone as 16 kHz PCM to the realtime transcription address
 * the service hands out, and reads replies aloud in pieces so the first
 * sentence plays while the rest is still being made.
 *
 * The microphone is released the moment recording or voice mode ends. Every
 * failure a person can meet is a sentence they can act on.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { adapter } from '../experience/adapter.ts';
import type { VoiceStatus } from '../experience/types.ts';

/* ---------- whether voice is here at all ---------- */

let status: Promise<VoiceStatus | null> | null = null;

/** Read once per page: the installation's voice features do not change under it. */
export function useVoiceStatus(): VoiceStatus | null {
  const [value, setValue] = useState<VoiceStatus | null>(null);
  useEffect(() => {
    status ??= adapter.voice().then((result) => result.data);
    let live = true;
    void status.then((read) => {
      if (live) setValue(read);
    });
    return () => {
      live = false;
    };
  }, []);
  return value;
}

/* ---------- the microphone ---------- */

/** What a failed request for the microphone means, in words a person can act on. */
export function microphoneProblem(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Melete can’t use your microphone. Allow it for this site in your browser, then try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return 'No microphone was found. Connect one and try again.';
  if (name === 'NotReadableError')
    return 'Your microphone is busy in another app. Close it there and try again.';
  return 'Your microphone could not be started. Try again.';
}

async function microphone(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia)
    throw Object.assign(new Error('unsupported'), { name: 'Unsupported' });
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
}

const release = (stream: MediaStream | null) => {
  for (const track of stream?.getTracks() ?? []) track.stop();
};

/** The first recording format this browser can make that the service reads. */
function recordingType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(
    (type) => MediaRecorder.isTypeSupported(type),
  );
}

/** `0:07` for a running recording. */
export const elapsed = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** The clock, ticking while `active`, for a running recording's length. */
export function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/* ---------- push-to-talk ---------- */

export type RecorderState = 'idle' | 'starting' | 'recording' | 'transcribing';

/**
 * Tap to record, tap again to stop. The recorder stops itself at the service's
 * limit, so a clip is never refused for its length.
 */
export function useRecorder(options: { maxSeconds: number; onText: (text: string) => void }) {
  const [state, setState] = useState<RecorderState>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const limit = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onText = useRef(options.onText);
  onText.current = options.onText;

  const finish = useCallback(async (chunks: Blob[], type: string, durationMs: number) => {
    setState('transcribing');
    const clip = new Blob(chunks, { type: type.split(';')[0] || 'audio/webm' });
    const result = await adapter.transcribe(clip, durationMs);
    setState('idle');
    if (result.data === null) {
      setProblem(result.error ?? result.unavailable ?? 'That recording could not be transcribed.');
      return;
    }
    const text = result.data.text.trim();
    if (!text) setProblem('Nothing was heard. Try again a little closer to the microphone.');
    else onText.current(text);
  }, []);

  const stop = useCallback(() => {
    if (limit.current) clearTimeout(limit.current);
    limit.current = null;
    if (recorder.current?.state === 'recording') recorder.current.stop();
  }, []);

  const start = useCallback(async () => {
    setProblem(null);
    const type = recordingType();
    if (!type) {
      setProblem('This browser can’t record audio here.');
      return;
    }
    setState('starting');
    try {
      stream.current = await microphone();
    } catch (error) {
      setState('idle');
      setProblem(
        error instanceof Error && error.name === 'Unsupported'
          ? 'This browser can’t record audio here.'
          : microphoneProblem(error),
      );
      return;
    }
    const chunks: Blob[] = [];
    const began = performance.now();
    const made = new MediaRecorder(stream.current, { mimeType: type });
    made.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    made.onstop = () => {
      release(stream.current);
      stream.current = null;
      recorder.current = null;
      void finish(chunks, made.mimeType || type, performance.now() - began);
    };
    recorder.current = made;
    made.start();
    setStartedAt(Date.now());
    setState('recording');
    limit.current = setTimeout(stop, options.maxSeconds * 1000 - 250);
  }, [finish, stop, options.maxSeconds]);

  // Leaving the screen mid-recording drops the clip and frees the microphone.
  useEffect(
    () => () => {
      if (limit.current) clearTimeout(limit.current);
      if (recorder.current) {
        recorder.current.onstop = null;
        if (recorder.current.state === 'recording') recorder.current.stop();
      }
      release(stream.current);
    },
    [],
  );

  const toggle = useCallback(() => {
    if (state === 'recording') stop();
    else if (state === 'idle') void start();
  }, [state, start, stop]);

  return { state, problem, startedAt, toggle, dismiss: () => setProblem(null) };
}

/* ---------- voice mode: microphone to realtime PCM ---------- */

/**
 * 16-bit PCM at `to` Hz from float samples at `from` Hz, each output sample the
 * average of the input samples it covers.
 */
export function downsample(input: Float32Array, from: number, to: number): Int16Array {
  const ratio = from / to;
  const length = Math.floor(input.length / ratio);
  const out = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.max(start + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end && j < input.length; j += 1) sum += input[j] ?? 0;
    const sample = Math.max(-1, Math.min(1, sum / (end - start)));
    out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return out;
}

export function base64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const TAP = `class MeleteMicTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('melete-mic-tap', MeleteMicTap);`;

/**
 * The microphone as a stream of 16 kHz PCM chunks of about a tenth of a
 * second. `close` stops the tracks and the audio graph.
 */
export async function openMicrophone(
  sampleRate: number,
  onChunk: (pcm: Int16Array) => void,
): Promise<{ close: () => void }> {
  const stream = await microphone();
  const context = new AudioContext();
  try {
    const module = URL.createObjectURL(new Blob([TAP], { type: 'text/javascript' }));
    await context.audioWorklet.addModule(module);
    URL.revokeObjectURL(module);
    const source = context.createMediaStreamSource(stream);
    const tap = new AudioWorkletNode(context, 'melete-mic-tap');
    // The tap has to be pulled to run; a silent gain carries it to the output.
    const quiet = context.createGain();
    quiet.gain.value = 0;
    source.connect(tap).connect(quiet).connect(context.destination);
    let pending: number[] = [];
    const chunk = Math.round(sampleRate / 10);
    tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const samples = downsample(event.data, context.sampleRate, sampleRate);
      pending = pending.concat(Array.from(samples));
      while (pending.length >= chunk) {
        onChunk(Int16Array.from(pending.slice(0, chunk)));
        pending = pending.slice(chunk);
      }
    };
    return {
      close: () => {
        tap.port.onmessage = null;
        release(stream);
        void context.close().catch(() => undefined);
      },
    };
  } catch (error) {
    release(stream);
    void context.close().catch(() => undefined);
    throw error;
  }
}

/* ---------- voice mode: replies read aloud ---------- */

/**
 * A reply as it should sound: no Markdown marks, links read by their words,
 * code left on the screen.
 */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' There is code on the screen. ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.|>)\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(\S[^*_~]*?)\1/g, '$2')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Longest piece one speech request reads; the service's own limit is higher. */
const PIECE = 400;

/**
 * The part of `text` from `from` that ends in a finished sentence, and where it
 * ends. With `final`, whatever is left is finished too. Long sentences are cut
 * at a comma or space so no piece passes the limit.
 */
export function nextPiece(
  text: string,
  from: number,
  final: boolean,
): { piece: string; end: number } | null {
  const rest = text.slice(from);
  if (!rest.trim()) return null;
  const sentences = /[.!?…](?=\s|$)|\n/g;
  let end = -1;
  for (let match = sentences.exec(rest); match; match = sentences.exec(rest)) {
    if (match.index + 1 > PIECE) break;
    end = match.index + 1;
    if (end >= 80) break;
  }
  if (end < 0 && rest.length > PIECE) {
    const cut = Math.max(rest.lastIndexOf(', ', PIECE), rest.lastIndexOf(' ', PIECE));
    end = cut > 0 ? cut + 1 : PIECE;
  }
  if (end < 0) {
    if (!final) return null;
    end = rest.length;
  }
  return { piece: rest.slice(0, end).trim(), end: from + end };
}
