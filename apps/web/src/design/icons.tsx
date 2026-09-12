/**
 * Every icon in the product, as the design canvas draws it: one 24 viewBox,
 * stroke only, round caps and joins. The nav family is drawn at 1.55, the
 * general set at 1.75. Generated from the canvas source; edit there.
 */
import type { CSSProperties } from 'react';

export const ICON_PATHS = {
  home: '<path d="m3.5 10 8.5-7 8.5 7v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5"/><path d="M9 21v-7h6v7"/><path d="M12 7.5v1"/>',
  inbox:
    '<path d="M4 9.5 6.5 4h11L20 9.5V19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5"/><path d="M4 12h4l1.5 3h5l1.5-3h4"/><path d="M9 7.5h6"/>',
  chat: '<path d="M8 20 3.5 21l1-4.5A8.5 8.5 0 1 1 8 20Z"/><path d="M8 10h8M8 14h4"/><path d="M16 14h.01"/>',
  plans:
    '<path d="M6 4h9l4 4v12H6z"/><path d="M15 4v4h4"/><path d="m9 12 1.5 1.5L14 10"/><path d="M9 17h6"/>',
  messages:
    '<path d="M4 13H3V4h13v3"/><path d="M8 9h13v10h-4l-4 3v-3H8Z"/><path d="M12 13h5M12 15.5h3"/>',
  automations:
    '<path d="M6 7a8 8 0 0 1 13 1l1 2"/><path d="M18 17a8 8 0 0 1-13-1l-1-2"/><path d="M20 5v5h-5"/><path d="M4 19v-5h5"/><path d="m12.8 9.6-2.3 3.1h3l-2.3 3.1"/>',
  calendar:
    '<path d="M4 11V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4M8 2v4M16 2v4M4 9h16"/><rect x="8" y="13" width="3" height="3" rx=".6"/><path d="M15 14h1"/>',
  connectors:
    '<path d="m9 6 2-2a5 5 0 0 1 7 7l-2 2M15 18l-2 2a5 5 0 0 1-7-7l2-2"/><path d="m8 16 8-8"/>',
  files:
    '<path d="M3 10V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M3 11h18"/><path d="M15 16h2"/>',
  compose:
    '<path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="m10 14 1-4 7.5-7.5a1.4 1.4 0 0 1 2 2L13 12Z"/><path d="m16 5 3 3M8 17h5"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  panelLeft: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
  panelRight: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronsUpDown: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>',
  arrowUp: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  arrowDown: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  arrowUpRight: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  paperclip:
    '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  fileText:
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14 2 9.27l6.91-1.01L12 2z"/>',
  mapPin:
    '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  copy: '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  thumbsUp:
    '<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>',
  thumbsDown:
    '<path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/>',
  refresh:
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  share:
    '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="m16 6-4-4-4 4"/><path d="M12 2v13"/>',
  pin: '<path d="M12 17v5"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>',
  square: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  sparkles:
    '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>',
  menu: '<path d="M4 12h16"/><path d="M4 6h16"/><path d="M4 18h16"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  globe:
    '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  compass:
    '<circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>',
  book: '<path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z"/>',
  piggy:
    '<rect x="3" y="7" width="18" height="12" rx="3"/><path d="M8 11h3"/><path d="M17 13h.01"/><path d="M9 7V5a3 3 0 0 1 6 0v2"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  logout:
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  sliders:
    '<path d="M21 4h-7"/><path d="M10 4H3"/><path d="M21 12h-9"/><path d="M8 12H3"/><path d="M21 20h-5"/><path d="M12 20H3"/><path d="M14 2v4"/><path d="M8 10v4"/><path d="M16 18v4"/>',
  loader: '<path d="M21 12a9 9 0 1 1-6.22-8.56"/>',
  circleCheck: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  circleX: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  shuffle:
    '<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/>',
  upload:
    '<path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  smile:
    '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01"/><path d="M15 9h.01"/>',
  google: '<circle cx="12" cy="12" r="9"/><path d="M12 12h8"/><path d="M12 3a9 9 0 0 1 6.4 2.6"/>',
  apple:
    '<path d="M12 6c1.5-2 4-2 5-1.5-1 .5-2 2-1.5 3.5M7 9c-2 2-2 8 1 12 1 1 2 1 3 .5s2-.5 3 0 2 .5 3-.5c1.5-2 2-3.5 2-4-2-1-2.5-4 0-5.5-1-1.5-3-2-4.5-1.5s-2 .5-3 0S8 8 7 9z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  frame: '<path d="M22 6H2"/><path d="M22 18H2"/><path d="M6 2v20"/><path d="M18 2v20"/>',
  rectTool: '<rect x="3" y="5" width="18" height="14" rx="2"/>',
  pen: '<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/>',
  typeT: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  skipBack: '<path d="M19 20 9 12l10-8z"/><path d="M5 19V5"/>',
  skipFwd: '<path d="m5 4 10 8-10 8z"/><path d="M19 5v14"/>',
  volume: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>',
  trendUp: '<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  cursor: '<path d="M4 4l7.5 16 2.2-6.3L20 11.5z"/>',
  maximize:
    '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
} as const;

export type IconName = keyof typeof ICON_PATHS;

const NAV: ReadonlySet<string> = new Set([
  'home',
  'inbox',
  'chat',
  'plans',
  'messages',
  'automations',
  'calendar',
  'connectors',
  'files',
  'compose',
]);

export function Icon({
  name,
  size = 16,
  stroke,
  fill = 'none',
  className,
  style,
}: {
  name: IconName;
  size?: number;
  stroke?: number;
  fill?: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth={stroke ?? (NAV.has(name) ? 1.55 : 1.75)}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flexShrink: 0, ...style }}
      aria-hidden="true"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: static paths from the design source
      dangerouslySetInnerHTML={{ __html: ICON_PATHS[name] }}
    />
  );
}
