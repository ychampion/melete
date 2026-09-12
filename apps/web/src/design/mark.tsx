/**
 * The Melete mark. It is rendered bare, never on a tile or a coloured
 * background: next to the wordmark in the header, and in a square slot as the
 * assistant's chat avatar when no agent persona is speaking.
 */

const MARK_RATIO = 0.43;

export function MeleteMark({ width = 36 }: { width?: number }) {
  return (
    <img
      src="/melete-logo.png"
      alt="Melete"
      style={{ width, height: Math.round(width * MARK_RATIO), display: 'block', flexShrink: 0 }}
    />
  );
}

export function MeleteAvatar({ size = 28 }: { size?: number }) {
  return (
    <span
      className="row"
      style={{ justifyContent: 'center', width: size, height: size, flexShrink: 0 }}
      aria-hidden="true"
    >
      <MeleteMark width={size} />
    </span>
  );
}
