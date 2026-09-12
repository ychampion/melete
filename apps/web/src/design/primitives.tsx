/**
 * The primitives every screen is built from: Button, IconButton, Badge, Chip,
 * Input, Checkbox, Radio, Toggle, Segmented, TabsUnderline, plus the small
 * pieces they share (Kbd, Count, Avatar, Overline, Menu, Dialog). Anatomy and
 * tokens come from the design canvas; the classes live in base.css.
 */
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  cloneElement,
  type InputHTMLAttributes,
  isValidElement,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from 'react';
import { Icon, type IconName } from './icons.tsx';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'outline'
  | 'ghost'
  | 'destructive'
  | 'link'
  | 'soft';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl';

const ICON_SIZE: Record<ButtonSize, number> = { sm: 16, md: 16, lg: 18, xl: 18 };

export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  iconRight,
  loading = false,
  block = false,
  children,
  className,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconRight?: IconName;
  loading?: boolean;
  block?: boolean;
}) {
  const classes = [
    'btn',
    `btn-${size}`,
    `btn-${variant}`,
    block ? 'btn-block' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button type={type} className={classes} {...rest}>
      {loading ? (
        <Icon name="loader" size={ICON_SIZE[size]} stroke={2} className="spin" />
      ) : icon ? (
        <Icon name={icon} size={ICON_SIZE[size]} />
      ) : null}
      {children ? <span>{children}</span> : null}
      {iconRight ? <Icon name={iconRight} size={14} /> : null}
    </button>
  );
}

export type IconButtonVariant = 'ghost' | 'soft' | 'primary' | 'mutedFill' | 'outline';

const ICON_BTN_CLASS: Record<IconButtonVariant, string> = {
  ghost: 'icon-ghost',
  soft: 'icon-soft',
  primary: 'icon-primary',
  mutedFill: 'icon-muted-fill',
  outline: 'icon-outline',
};

export function IconButton({
  name,
  label,
  size = 32,
  iconSize = 16,
  variant = 'ghost',
  on = false,
  className,
  style,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  name: IconName;
  /** Every icon-only control names itself for assistive tech and tooltips. */
  label: string;
  size?: number;
  iconSize?: number;
  variant?: IconButtonVariant;
  on?: boolean;
}) {
  return (
    <button
      type={type}
      className={['icon-btn', ICON_BTN_CLASS[variant], className ?? ''].filter(Boolean).join(' ')}
      style={{ width: size, height: size, ...style }}
      aria-label={label}
      title={label}
      data-on={on ? 'true' : undefined}
      {...rest}
    >
      <Icon name={name} size={iconSize} />
    </button>
  );
}

export type BadgeTone =
  | 'neutral'
  | 'outline'
  | 'success'
  | 'danger'
  | 'chip'
  | 'travel'
  | 'wellbeing'
  | 'learning'
  | 'finance'
  | 'blue';

const BADGE_STYLE: Record<BadgeTone, CSSProperties> = {
  neutral: { background: 'var(--line)', color: 'var(--secondary)' },
  outline: { background: 'transparent', color: 'var(--muted)', borderColor: 'var(--line-strong)' },
  success: { background: 'var(--success-soft)', color: 'var(--success)' },
  danger: { background: 'var(--danger-soft)', color: 'var(--danger)' },
  chip: { background: 'var(--chip-bg)', color: 'var(--text)' },
  travel: { background: 'var(--travel)', color: 'var(--travel-ink)' },
  wellbeing: { background: 'var(--sage)', color: 'var(--sage-ink)' },
  learning: { background: 'var(--lilac)', color: 'var(--lilac-ink)' },
  finance: { background: 'var(--sand)', color: 'var(--sand-ink)' },
  blue: { background: 'var(--blue-soft)', color: 'var(--blue-ink)' },
};

export function Badge({
  tone = 'neutral',
  dot = false,
  children,
  style,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <span className="badge" style={{ ...BADGE_STYLE[tone], ...style }}>
      {dot ? <span className="badge-dot" style={{ background: 'currentColor' }} /> : null}
      {children}
    </span>
  );
}

export function Count({ n, active = false }: { n: number | string; active?: boolean }) {
  return (
    <span className="count" data-active={active ? 'true' : undefined}>
      {n}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

export function Avatar({
  initials,
  size = 32,
  tone = 'blue',
}: {
  initials: string;
  size?: number;
  tone?: 'blue' | 'sage' | 'sand' | 'lilac';
}) {
  const tones = {
    blue: ['var(--blue-soft)', 'var(--blue-ink)'],
    sage: ['var(--sage)', 'var(--sage-ink)'],
    sand: ['var(--sand)', 'var(--sand-ink)'],
    lilac: ['var(--lilac)', 'var(--lilac-ink)'],
  } as const;
  const [bg, fg] = tones[tone];
  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        background: bg,
        color: fg,
        fontSize: Math.max(11, Math.round(size * 0.38)),
      }}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}

export function Chip({
  icon,
  on = false,
  size = 32,
  children,
  className,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: IconName;
  on?: boolean;
  size?: number;
}) {
  return (
    <button
      type={type}
      className={['chip', className ?? ''].filter(Boolean).join(' ')}
      style={{ height: size }}
      data-on={on ? 'true' : undefined}
      aria-pressed={on || undefined}
      {...rest}
    >
      {icon ? <Icon name={icon} size={14} /> : null}
      <span>{children}</span>
    </button>
  );
}

export function Input({
  icon,
  trailing,
  error = false,
  height = 36,
  width,
  className,
  disabled,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  icon?: IconName;
  trailing?: ReactNode;
  error?: boolean;
  height?: number;
  width?: number | string;
}) {
  return (
    <label
      className={['input', className ?? ''].filter(Boolean).join(' ')}
      style={{ height, width }}
      data-icon={icon ? 'true' : undefined}
      data-error={error ? 'true' : undefined}
      data-disabled={disabled ? 'true' : undefined}
    >
      {icon ? (
        <span className="input-icon">
          <Icon name={icon} size={16} />
        </span>
      ) : null}
      <input disabled={disabled} {...rest} />
      {trailing}
    </label>
  );
}

export function Select({
  icon,
  value,
  onChange,
  options,
  height = 36,
  width,
  label,
  id,
}: {
  icon?: IconName;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  height?: number;
  width?: number | string;
  label: string;
  id?: string;
}) {
  return (
    <label className="input" style={{ height, width }} data-icon={icon ? 'true' : undefined}>
      {icon ? (
        <span className="input-icon">
          <Icon name={icon} size={16} />
        </span>
      ) : null}
      <select
        id={id}
        aria-label={id ? undefined : label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <span className="input-icon">
        <Icon name="chevronDown" size={16} />
      </span>
    </label>
  );
}

export function Checkbox({
  checked,
  onChange,
  round = false,
  disabled = false,
  label,
}: {
  checked: boolean;
  onChange?: (next: boolean) => void;
  round?: boolean;
  disabled?: boolean;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      className="checkbox"
      aria-label={label}
      checked={checked}
      data-round={round ? 'true' : undefined}
      disabled={disabled}
      onChange={(event) => onChange?.(event.target.checked)}
    />
  );
}

export function Radio({
  on,
  onSelect,
  label,
}: {
  on: boolean;
  onSelect?: () => void;
  label: string;
}) {
  return (
    <input
      type="radio"
      className="radio"
      aria-label={label}
      checked={on}
      onChange={() => onSelect?.()}
    />
  );
}

export function Toggle({
  on,
  onChange,
  disabled = false,
  label,
}: {
  on: boolean;
  onChange?: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className="toggle"
      data-on={on ? 'true' : undefined}
      disabled={disabled}
      onClick={() => onChange?.(!on)}
    >
      <span />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (next: T) => void;
  options: readonly { value: T; label: string }[];
  label: string;
}) {
  return (
    <fieldset className="segmented" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}

export function TabsUnderline<T extends string>({
  value,
  onChange,
  tabs,
  label,
}: {
  value: T;
  onChange: (next: T) => void;
  tabs: readonly { value: T; label: string; count?: number }[];
  label: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={tab.value === value}
          onClick={() => onChange(tab.value)}
        >
          {tab.label}
          {tab.count ? <Count n={tab.count} /> : null}
        </button>
      ))}
    </div>
  );
}

export function Overline({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="overline" style={style}>
      {children}
    </div>
  );
}

export function Hairline() {
  return <div className="hairline" />;
}

/**
 * A labelled control. When the child is a single input, select or textarea the
 * label is a real `<label for>` and the control gets the id, so the name reaches
 * assistive technology and clicking the label focuses the field. A group of
 * chips or a segmented control is named through `aria-labelledby` instead.
 */
export function Field({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  const labelStyle = { fontSize: 13, fontWeight: 500, color: 'var(--heading)' } as const;
  const single = isValidElement<{ id?: string }>(children) ? children : null;
  const labelable =
    single !== null &&
    (single.type === Input ||
      single.type === Select ||
      single.type === 'input' ||
      single.type === 'select' ||
      single.type === 'textarea');
  if (labelable && single) {
    const controlId = single.props.id ?? id;
    return (
      <div className="col" style={{ gap: 6 }}>
        <label htmlFor={controlId} style={labelStyle}>
          {label}
        </label>
        {cloneElement(single, { id: controlId })}
        {hint ? <span style={{ fontSize: 12, color: 'var(--muted)' }}>{hint}</span> : null}
      </div>
    );
  }
  return (
    <fieldset className="col field-group" style={{ gap: 6 }}>
      <legend style={labelStyle}>{label}</legend>
      {children}
      {hint ? <span style={{ fontSize: 12, color: 'var(--muted)' }}>{hint}</span> : null}
    </fieldset>
  );
}

/* ---------- menus ---------- */

export function Menu({
  children,
  width = 208,
  label,
  style,
}: {
  children: ReactNode;
  width?: number;
  label: string;
  style?: CSSProperties;
}) {
  return (
    <div className="menu" role="menu" aria-label={label} style={{ width, ...style }}>
      {children}
    </div>
  );
}

export function MenuItem({
  icon,
  children,
  kbd,
  sub = false,
  on = false,
  danger = false,
  onSelect,
}: {
  icon: IconName;
  children: ReactNode;
  kbd?: string;
  sub?: boolean;
  on?: boolean;
  danger?: boolean;
  onSelect?: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="menu-item"
      data-danger={danger ? 'true' : undefined}
      onClick={onSelect}
    >
      <Icon name={icon} size={16} />
      <span className="grow">{children}</span>
      {kbd ? <Kbd>{kbd}</Kbd> : null}
      {sub ? <Icon name="chevronRight" size={14} style={{ color: 'var(--muted)' }} /> : null}
      {on ? (
        <Icon name="check" size={14} stroke={2.25} style={{ color: 'var(--heading)' }} />
      ) : null}
    </button>
  );
}

export function MenuSep() {
  return <hr className="menu-sep" />;
}

/**
 * A popover anchored to its trigger. Closes on Escape and on a click outside;
 * the trigger keeps the focus story simple by owning aria-expanded.
 */
export function Popover({
  open,
  onClose,
  children,
  align = 'left',
  side = 'bottom',
  offset = 6,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: 'left' | 'right';
  side?: 'bottom' | 'top';
  offset?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Callers pass a fresh arrow each render; the listeners must not re-bind for that.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
    };
    const onDown = (event: MouseEvent) => {
      const node = ref.current;
      if (node && !node.parentElement?.contains(event.target as Node)) close.current();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open]);
  if (!open) return null;
  return (
    <div
      ref={ref}
      style={{
        position: 'absolute',
        zIndex: 30,
        ...(side === 'bottom'
          ? { top: `calc(100% + ${offset}px)` }
          : { bottom: `calc(100% + ${offset}px)` }),
        ...(align === 'left' ? { left: 0 } : { right: 0 }),
      }}
    >
      {children}
    </div>
  );
}

/* ---------- dialog ---------- */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog: focus moves in on open, Tab cycles inside, Escape closes,
 * and focus returns to the trigger on close.
 */
export function Dialog({
  open,
  onClose,
  title,
  sub,
  children,
  footer,
  width = 440,
  icon,
  tone,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  sub?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
  icon?: IconName;
  tone?: 'danger';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  /**
   * The focus effect depends on `open` alone. Every caller passes `onClose` as
   * a fresh inline arrow, and re-running this effect on a parent render would
   * hand focus back to the trigger and then to the Close button, so a dialog
   * would take one keystroke and lose the rest.
   */
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    // A field with autoFocus already holds focus; otherwise start at the first control.
    if (!node?.contains(document.activeElement)) {
      const first = node?.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? node)?.focus();
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close.current();
        return;
      }
      if (event.key !== 'Tab' || !node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const head = items[0];
      const tail = items[items.length - 1];
      if (!head || !tail) return;
      if (event.shiftKey && document.activeElement === head) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && document.activeElement === tail) {
        event.preventDefault();
        head.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the scrim closes the dialog on an outside click; Escape does the same for the keyboard
    <div
      className="scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ width }}
      >
        <div className="dialog-head">
          {icon ? (
            <span
              className="row"
              style={{
                justifyContent: 'center',
                width: 36,
                height: 36,
                borderRadius: 10,
                background: tone === 'danger' ? 'var(--danger-soft)' : 'var(--blue-soft)',
                color: tone === 'danger' ? 'var(--danger)' : 'var(--blue-ink)',
                marginBottom: 4,
              }}
            >
              <Icon name={icon} size={18} />
            </span>
          ) : null}
          <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
            <h3 id={titleId} style={{ fontSize: 20, fontWeight: 600 }}>
              {title}
            </h3>
            {icon ? null : <IconButton name="x" label="Close" onClick={onClose} />}
          </div>
          {sub ? <p style={{ fontSize: 14, color: 'var(--muted)' }}>{sub}</p> : null}
        </div>
        {children ? <div className="dialog-body">{children}</div> : <div style={{ height: 20 }} />}
        {footer ? <div className="dialog-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

/* ---------- feedback ---------- */

export function Toast({
  kind,
  title,
  sub,
  action,
  onAction,
  onClose,
}: {
  kind: 'ok' | 'err' | 'info';
  title: string;
  sub?: string;
  action?: string;
  onAction?: () => void;
  onClose?: () => void;
}) {
  const icon: IconName = kind === 'ok' ? 'circleCheck' : kind === 'err' ? 'circleX' : 'info';
  const color =
    kind === 'ok' ? 'var(--success)' : kind === 'err' ? 'var(--danger)' : 'var(--primary)';
  return (
    <div className="toast" role="status">
      <span style={{ color, display: 'flex' }}>
        <Icon name={icon} size={18} />
      </span>
      <div className="col grow" style={{ gap: 2 }}>
        <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}>{title}</span>
        {sub ? <span style={{ fontSize: 13, color: 'var(--muted)' }}>{sub}</span> : null}
      </div>
      {action ? (
        <Button size="sm" variant="outline" onClick={onAction}>
          {action}
        </Button>
      ) : null}
      {onClose ? (
        <IconButton name="x" label="Dismiss" size={28} iconSize={14} onClick={onClose} />
      ) : null}
    </div>
  );
}

export function Skeleton({ width, height = 12 }: { width: number | string; height?: number }) {
  return <div className="shimmer" style={{ width, height, borderRadius: 6 }} aria-hidden="true" />;
}
