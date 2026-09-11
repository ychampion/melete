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
  shape: FaceShape;
  /** An imported SVG or PNG face, as a data URL, replaces the drawn one. */
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
      strokeWidth={kind === 'octagon' ? 12 : 8}
      fill={fill}
      stroke={stroke}
      {...extra}
    />
  );
}

function Pill({ x, y, w, h, fill }: { x: number; y: number; w: number; h: number; fill: string }) {
  return <rect x={x} y={y} width={w} height={h} rx={Math.min(w, h) / 2} fill={fill} />;
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
  const eye = eyes === 'white' ? '#ffffff' : '#16181d';

  if (look.image) {
    return (
      <span
        className={`af af-${state}`}
        style={{
          display: 'inline-flex',
          width: size,
          height: size,
          flexShrink: 0,
          filter: glow ? `drop-shadow(0 0 ${Math.round(size * 0.22)}px ${color}80)` : undefined,
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

  let eyesEl: React.ReactNode;
  if (eyes === 'none') eyesEl = null;
  else if (state === 'done')
    eyesEl = (
      <path
        d="M31 51q7-9 14 0M55 51q7-9 14 0"
        stroke={eye}
        strokeWidth="5"
        strokeLinecap="round"
        fill="none"
      />
    );
  else if (state === 'failed')
    eyesEl = (
      <path d="M32 46l12 6M68 46l-12 6" stroke={eye} strokeWidth="5" strokeLinecap="round" />
    );
  else if (state === 'inactive')
    eyesEl = <path d="M32 50h12M56 50h12" stroke={eye} strokeWidth="5" strokeLinecap="round" />;
  else if (state === 'invalid' || state === 'working')
    eyesEl = (
      <>
        <Pill x={34} y={46} w={9} h={9} fill={eye} />
        <Pill x={57} y={46} w={9} h={9} fill={eye} />
      </>
    );
  else if (state === 'thinking')
    eyesEl = (
      <>
        <Pill x={33} y={45} w={10} h={10} fill={eye} />
        <Pill x={57} y={45} w={10} h={10} fill={eye} />
      </>
    );
  else if (state === 'deep')
    eyesEl = (
      <>
        <Pill x={33} y={47} w={10} h={7} fill={eye} />
        <Pill x={57} y={47} w={10} h={7} fill={eye} />
      </>
    );
  else
    eyesEl = (
      <>
        <Pill x={33} y={42} w={10} h={16} fill={eye} />
        <Pill x={57} y={42} w={10} h={16} fill={eye} />
      </>
    );

  const filters = [
    glow ? `drop-shadow(0 0 ${Math.round(size * 0.22)}px ${color}80)` : '',
    state === 'inactive' ? 'saturate(.6)' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <svg
      className={`af af-${state}`}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      style={{ flexShrink: 0, overflow: 'visible', filter: filters || undefined }}
      aria-hidden="true"
    >
      <defs>
        <clipPath id={clipId}>
          <Shape kind={shape} />
        </clipPath>
      </defs>
      <g className="af-body">
        <g>
          <Shape kind={shape} fill={color} stroke={color} />
        </g>
        <g className="af-facets" clipPath={`url(#${clipId})`}>
          <g opacity=".22" transform="rotate(30 50 50) translate(16 -12) scale(.88)">
            <Shape kind={shape} fill="#ffffff" stroke="#ffffff" />
          </g>
          <g opacity=".14" transform="rotate(-24 50 50) translate(-14 14) scale(.9)">
            <Shape kind={shape} fill="#000000" stroke="#000000" />
          </g>
          <rect
            x="-20"
            y="38"
            width="140"
            height="22"
            fill="#ffffff"
            opacity=".10"
            transform="rotate(-38 50 50)"
          />
        </g>
        <g className="af-eyes">{eyesEl}</g>
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
