/**
 * Agent faces: a coloured surface (rounded, blob, diamond, octagon, gear), a
 * pair of eyes, and nine states the interface derives from a turn's status.
 * The face is the only place an agent's colour appears; the rest of the
 * interface stays neutral.
 */
import { useId } from 'react';

export const FACE_PALETTE = [
  '#f5dfb4',
  '#f4c430',
  '#ec8a2b',
  '#f3a4c8',
  '#f26a4e',
  '#c92a2a',
  '#c9c1f5',
  '#4aa3f7',
  '#a43fc8',
  '#c8c95a',
  '#5ab4a0',
  '#0f8f7a',
] as const;

export const FACE_SHAPES = [
  ['square', 'Rounded'],
  ['blob', 'Blob'],
  ['diamond', 'Diamond'],
  ['octagon', 'Octagon'],
  ['gear', 'Gear'],
] as const;
export type FaceShape = (typeof FACE_SHAPES)[number][0];

export const FACE_STATES = [
  ['idle', 'Idle', 'blink'],
  ['observing', 'Observing', 'around'],
  ['thinking', 'Thinking', 'searching'],
  ['deep', 'Deep thinking', 'processing'],
  ['working', 'Working', 'busy'],
  ['done', 'Done', 'celebrating'],
  ['failed', 'Failed', 'failed'],
  ['invalid', 'Invalid', 'rejected'],
  ['inactive', 'Inactive', 'asleep'],
] as const;
export type FaceState = (typeof FACE_STATES)[number][0];

export type FaceEyes = 'white' | 'black' | 'none';

export type FaceLook = {
  color: string;
  eyes: FaceEyes;
  /** The exact eye colour when the record carries one; `eyes` is the fallback. */
  eyeColor?: string;
  shape: FaceShape;
  /** An imported SVG or PNG face, as a URL, replaces the drawn one. */
  image?: string | null;
};

function shapePoints(kind: FaceShape): string {
  const points: string[] = [];
  const n = 96;
  for (let i = 0; i < n; i++) {
    const th = (i / n) * Math.PI * 2;
    let r = 40;
    if (kind === 'blob') r = 38 + 7 * Math.cos(6 * th);
    else if (kind === 'gear') r = 38 + 5.5 * Math.cos(12 * th);
    else if (kind === 'octagon') {
      const k = Math.PI / 4;
      const a = ((th % k) + k) % k;
      r = (41 * Math.cos(k / 2)) / Math.cos(a - k / 2);
    }
    points.push(`${(50 + r * Math.cos(th)).toFixed(1)},${(50 + r * Math.sin(th)).toFixed(1)}`);
  }
  return points.join(' ');
}

/** The stroke that rounds a drawn surface's corners, in viewBox units. */
const ROUNDING: Record<FaceShape, number> = {
  square: 1,
  diamond: 1,
  blob: 8,
  gear: 8,
  octagon: 12,
};

function Shape({
  kind,
  fill,
  stroke,
  extra,
}: {
  kind: FaceShape;
  fill?: string;
  stroke?: string;
  extra?: Record<string, string | number>;
}) {
  if (kind === 'square') {
    return (
      <rect x="10" y="10" width="80" height="80" rx="24" fill={fill} stroke={stroke} {...extra} />
    );
  }
  if (kind === 'diamond') {
    return (
      <rect
        x="16"
        y="16"
        width="68"
        height="68"
        rx="15"
        transform="rotate(45 50 50)"
        fill={fill}
        stroke={stroke}
        {...extra}
      />
    );
  }
  return (
    <polygon
      points={shapePoints(kind)}
      strokeLinejoin="round"
      strokeWidth={ROUNDING[kind]}
      fill={fill}
      stroke={stroke}
      {...extra}
    />
  );
}

function Pill({ x, y, w, h, fill }: { x: number; y: number; w: number; h: number; fill: string }) {
  return <rect x={x} y={y} width={w} height={h} rx={Math.min(w, h) / 2} fill={fill} />;
}

/** The soft glow behind a face: its own colour, scaled to the face and capped. */
export function faceGlow(color: string, size: number): string {
  const blur = Math.min(18, Math.max(4, Math.round(size * 0.16)));
  return `drop-shadow(0 0 ${blur}px color-mix(in srgb, ${color} 55%, transparent))`;
}

/**
 * The eyes for a state, drawn on the 100-unit face. Idle eyes are tall and
 * open; working eyes look down at the task; thinking eyes look up and aside;
 * done eyes smile.
 */
function Eyes({ state, eye }: { state: FaceState; eye: string }) {
  switch (state) {
    case 'done':
      return (
        <path
          d="M31 52q7-10 14 0M55 52q7-10 14 0"
          stroke={eye}
          strokeWidth="6"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      );
    case 'failed':
      return (
        <path
          d="M32 45l12 6M68 45l-12 6"
          stroke={eye}
          strokeWidth="6"
          strokeLinecap="round"
          fill="none"
        />
      );
    case 'inactive':
      return <path d="M32 51h12M56 51h12" stroke={eye} strokeWidth="6" strokeLinecap="round" />;
    case 'working':
      return (
        <>
          <Pill x={35} y={48} w={10} h={11} fill={eye} />
          <Pill x={58} y={48} w={10} h={11} fill={eye} />
        </>
      );
    case 'invalid':
      return (
        <>
          <Pill x={34} y={46} w={10} h={10} fill={eye} />
          <Pill x={56} y={46} w={10} h={10} fill={eye} />
        </>
      );
    case 'thinking':
      return (
        <>
          <Pill x={35} y={41} w={10} h={12} fill={eye} />
          <Pill x={58} y={41} w={10} h={12} fill={eye} />
        </>
      );
    case 'deep':
      return (
        <>
          <Pill x={33} y={47} w={11} h={7} fill={eye} />
          <Pill x={56} y={47} w={11} h={7} fill={eye} />
        </>
      );
    default:
      return (
        <>
          <Pill x={33} y={41} w={11} h={17} fill={eye} />
          <Pill x={56} y={41} w={11} h={17} fill={eye} />
        </>
      );
  }
}

export function AgentFace({
  look,
  size = 40,
  state = 'idle',
  glow = false,
}: {
  look: FaceLook;
  size?: number;
  state?: FaceState;
  glow?: boolean;
}) {
  const id = useId();
  const clipId = `af${id.replace(/[^a-zA-Z0-9]/g, '')}`;
  const { color, eyes, shape } = look;
  const eye = look.eyeColor ?? (eyes === 'white' ? '#ffffff' : '#16181d');

  if (look.image) {
    return (
      <span
        className={`af af-${state}`}
        style={{
          display: 'inline-flex',
          width: size,
          height: size,
          flexShrink: 0,
          filter: glow ? faceGlow(color, size) : undefined,
        }}
        aria-hidden="true"
      >
        <img
          className="af-body"
          src={look.image}
          alt=""
          style={{ width: size, height: size, objectFit: 'contain' }}
        />
      </span>
    );
  }

  // Small faces (lists, chat) drop the fine facets and draw the eyes a little
  // larger so they stay legible. Every face gets a hairline edge of about
  // three quarters of a pixel, so light colours keep their outline on paper.
  const small = size < 32;
  const edge = ROUNDING[shape] + (1.5 * 100) / size;
  const eyeScale = size <= 20 ? 1.2 : small ? 1.1 : 1;

  const filters = [glow ? faceGlow(color, size) : '', state === 'inactive' ? 'saturate(.6)' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <svg
      className={`af af-${state}`}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      shapeRendering="geometricPrecision"
      style={{ flexShrink: 0, overflow: 'visible', filter: filters || undefined }}
      aria-hidden="true"
    >
      <defs>
        <clipPath id={clipId}>
          <Shape kind={shape} />
        </clipPath>
      </defs>
      <g className="af-body">
        <Shape
          kind={shape}
          stroke="#000000"
          extra={{ strokeWidth: edge, strokeOpacity: 0.12, strokeLinejoin: 'round' }}
        />
        <Shape kind={shape} fill={color} stroke={color} />
        <g className="af-facets" clipPath={`url(#${clipId})`}>
          <g
            opacity={small ? 0.16 : 0.22}
            transform="rotate(30 50 50) translate(16 -12) scale(.88)"
          >
            <Shape kind={shape} fill="#ffffff" stroke="#ffffff" />
          </g>
          <g
            opacity={small ? 0.08 : 0.12}
            transform="rotate(-24 50 50) translate(-14 14) scale(.9)"
          >
            <Shape kind={shape} fill="#000000" stroke="#000000" />
          </g>
          {small ? null : (
            <rect
              x="-20"
              y="40"
              width="140"
              height="18"
              fill="#ffffff"
              opacity=".08"
              transform="rotate(-38 50 50)"
            />
          )}
        </g>
        {eyes === 'none' ? null : (
          <g className="af-eyes">
            {eyeScale === 1 ? (
              <Eyes state={state} eye={eye} />
            ) : (
              <g transform={`translate(50 50) scale(${eyeScale}) translate(-50 -50)`}>
                <Eyes state={state} eye={eye} />
              </g>
            )}
          </g>
        )}
      </g>
    </svg>
  );
}

/**
 * The face state the interface shows for a turn. The backend only exposes the
 * turn's status; the mapping to a face is a view concern and lives here.
 */
export function faceStateFor(
  status:
    | 'idle'
    | 'queued'
    | 'running'
    | 'streaming'
    | 'paused'
    | 'done'
    | 'failed'
    | 'invalid'
    | 'inactive'
    | undefined,
): FaceState {
  switch (status) {
    case 'queued':
      return 'observing';
    case 'running':
      return 'working';
    case 'streaming':
      return 'thinking';
    case 'paused':
      return 'deep';
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    case 'invalid':
      return 'invalid';
    case 'inactive':
      return 'inactive';
    default:
      return 'idle';
  }
}
