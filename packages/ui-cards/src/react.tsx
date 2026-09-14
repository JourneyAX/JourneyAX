'use client';
/**
 * React runtime for the card catalog: the primitive registry and the
 * `CardRenderer`. This is the ONLY React in the package and it is
 * tenant-agnostic by construction: every visual decision comes from
 * (a) the template spec (Mongo) and (b) `--jx-*` theme tokens.
 */
import React, { useMemo, useState } from 'react';
import { createRenderer, useActions } from '@json-render/react';
import type { Spec } from '@json-render/core';
import { catalog } from './catalog';
import type { CardInstance } from './catalog/card-types';

type P = Record<string, any>;
type RP = { props: P; children?: React.ReactNode; slots?: Record<string, React.ReactNode>; emit: (e: string) => void; loading?: boolean };

const sp = (k?: string) => (k && k !== '0' ? `var(--jx-space-${k})` : k === '0' ? '0' : undefined);
const cls = (...xs: (string | false | undefined | null)[]) => xs.filter(Boolean).join(' ');
const toneCls = (t?: string) => (t ? `jx-tone-${t}` : '');

function fmtMoney(amount: unknown, currency?: string): string | null {
  if (amount === null || amount === undefined || amount === '') return null;
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n)) return typeof amount === 'string' ? amount : null;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency || ''}`.trim();
  }
}

/** Fire a catalog action with a value merged into its params (for value-carrying primitives). */
function useEmitValue(props: P) {
  const { execute } = useActions();
  return (value: unknown) => {
    if (!props.action) return;
    const key = props.valueKey || 'value';
    void execute({ action: String(props.action), params: { ...(props.params || {}), [key]: value } } as any);
  };
}

/* ---------- icon set (inline SVG, no deps) ---------- */
const ICONS: Record<string, React.ReactNode> = {
  box: <><path d="M3 7l9-4 9 4v10l-9 4-9-4V7z" /><path d="M3 7l9 4 9-4M12 11v10" /></>,
  check: <path d="M5 13l4 4L19 7" />,
  cart: <><circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" /><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6" /></>,
  truck: <><path d="M1 3h15v13H1zM16 8h4l3 3v5h-7V8z" /><circle cx="5.5" cy="18.5" r="2.5" /><circle cx="18.5" cy="18.5" r="2.5" /></>,
  info: <><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></>,
  warning: <><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>,
  star: <path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z" />,
  spark: <path d="M12 2l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" />,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  'chevron-right': <path d="M9 6l6 6-6 6" />,
  'chevron-down': <path d="M6 9l6 6 6-6" />,
  close: <path d="M18 6L6 18M6 6l12 12" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>,
  tag: <><path d="M20.6 13.4L13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z" /><path d="M7 7h.01" /></>,
  ruler: <path d="M3 17l14-14 4 4L7 21zM8 12l2 2M11 9l2 2M14 6l2 2" />,
  shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  wrench: <path d="M14.7 6.3a4 4 0 0 0 5 5L22 9l-3-3-2.3.3zM3 21l8.5-8.5" />,
  gift: <><path d="M20 12v10H4V12M2 7h20v5H2zM12 22V7" /><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" /></>,
  user: <><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>,
  pin: <><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z" /><circle cx="12" cy="10" r="2.5" /></>,
  clock: <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>,
  doc: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" /></>,
  image: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></>,
};

export function JxIcon({ name, size = 'md', tone, className }: { name: string; size?: string; tone?: string; className?: string }) {
  const px = { xs: 12, sm: 14, md: 18, lg: 24, xl: 32 }[size] ?? 18;
  return (
    <svg className={cls('jx-icon', toneCls(tone), className)} width={px} height={px} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICONS[name] || ICONS.box}
    </svg>
  );
}

/* ---------- primitive implementations ---------- */
const components = {
  Box: ({ props, children }: RP) => (
    <div
      className={cls('jx-box', props.border && 'jx-border', props.bg && `jx-bg-${props.bg}`, props.radius && `jx-r-${props.radius}`, props.shadow && `jx-sh-${props.shadow}`, props.className)}
      data-testid={props.testId}
      style={{
        display: 'flex',
        flexDirection: props.direction === 'row' ? 'row' : 'column',
        gap: sp(props.gap),
        padding: sp(props.pad),
        alignItems: props.align === 'start' ? 'flex-start' : props.align === 'end' ? 'flex-end' : props.align,
        justifyContent: props.justify === 'between' ? 'space-between' : props.justify === 'around' ? 'space-around' : props.justify === 'start' ? 'flex-start' : props.justify === 'end' ? 'flex-end' : props.justify,
        flexWrap: props.wrap ? 'wrap' : undefined,
        width: props.width, maxWidth: props.maxWidth, minWidth: props.minWidth, height: props.height,
        flex: props.flex, overflow: props.overflow,
        ...(props.style || {}),
      }}
    >
      {children}
    </div>
  ),
  Card: ({ props, children, slots, emit }: RP) => (
    <div
      className={cls('jx-card', `jx-card-${props.variant || 'default'}`, props.selected && 'jx-selected', props.interactive && 'jx-interactive', props.className)}
      style={{ padding: sp(props.pad ?? 'md'), gap: sp(props.gap ?? 'sm'), ...(props.style || {}) }}
      onClick={props.interactive ? () => emit('press') : undefined}
      role={props.interactive ? 'button' : undefined}
    >
      {slots?.header ? <div className="jx-card-header">{slots.header}</div> : null}
      {children}
      {slots?.footer ? <div className="jx-card-footer">{slots.footer}</div> : null}
    </div>
  ),
  Grid: ({ props, children }: RP) => (
    <div
      className={cls('jx-grid', props.className)}
      style={{
        display: 'grid',
        gap: sp(props.gap ?? 'md'),
        gridTemplateColumns: props.columns ? `repeat(${props.columns}, minmax(0, 1fr))` : `repeat(auto-fill, minmax(${props.minItemWidth || '220px'}, 1fr))`,
        ...(props.style || {}),
      }}
    >
      {children}
    </div>
  ),
  Text: ({ props }: RP) => {
    const v = props.variant || 'body';
    const Tag: any = v === 'display' || v === 'title' ? 'h2' : v === 'heading' ? 'h3' : v === 'subheading' ? 'h4' : v === 'label' || v === 'eyebrow' || v === 'caption' ? 'span' : 'p';
    const style: React.CSSProperties = {
      textAlign: props.align === 'start' ? 'left' : props.align === 'end' ? 'right' : props.align,
      textTransform: props.uppercase ? 'uppercase' : undefined,
      ...(props.lines ? { display: '-webkit-box', WebkitLineClamp: props.lines, WebkitBoxOrient: 'vertical' as any, overflow: 'hidden' } : {}),
      ...(props.style || {}),
    };
    const text = props.text === undefined || props.text === null ? '' : String(props.text);
    return <Tag className={cls('jx-text', `jx-text-${v}`, toneCls(props.tone), props.weight && `jx-w-${props.weight}`, props.className)} style={style}>{text}</Tag>;
  },
  Image: ({ props }: RP) => {
    const [broken, setBroken] = useState(false);
    const ratio = props.ratio && props.ratio !== 'auto' ? props.ratio.replace(':', ' / ') : undefined;
    const show = props.src && !broken;
    return (
      <div className={cls('jx-image', props.radius && `jx-r-${props.radius}`, props.className)} style={{ aspectRatio: ratio, width: props.width, height: props.height, ...(props.style || {}) }}>
        {show ? (
          <img src={props.src} alt={props.alt || ''} loading="lazy" style={{ objectFit: props.fit || 'cover' }} onError={() => setBroken(true)} />
        ) : (
          <div className="jx-image-fallback"><JxIcon name={props.fallbackIcon || 'image'} size="lg" tone="muted" /></div>
        )}
      </div>
    );
  },
  Price: ({ props }: RP) => {
    const main = fmtMoney(props.amount, props.currency);
    const cmp = props.compareAt != null ? fmtMoney(props.compareAt, props.currency) : null;
    return (
      <div className={cls('jx-price', `jx-size-${props.size || 'md'}`, toneCls(props.tone), props.className)} style={props.style}>
        <span className="jx-price-main">{main ?? props.emptyText ?? 'Price on request'}</span>
        {cmp ? <span className="jx-price-compare">{cmp}</span> : null}
        {props.note ? <span className="jx-price-note">{props.note}</span> : null}
      </div>
    );
  },
  Badge: ({ props }: RP) => (
    <span className={cls('jx-badge', `jx-badge-${props.variant || 'soft'}`, toneCls(props.tone), props.uppercase && 'jx-upper', props.className)} style={props.style}>
      {props.icon ? <JxIcon name={props.icon} size="xs" /> : null}
      {props.text}
    </span>
  ),
  StatusDot: ({ props }: RP) => (
    <span className={cls('jx-status', toneCls(props.tone || 'success'), props.className)}>
      <span className={cls('jx-dot', props.pulse && 'jx-pulse')} />
      {props.label}
    </span>
  ),
  Button: ({ props, emit }: RP) => (
    <button
      type="button"
      className={cls('jx-btn', `jx-btn-${props.variant || 'primary'}`, `jx-size-${props.size || 'md'}`, props.fullWidth && 'jx-full', props.className)}
      disabled={!!props.disabled || !!props.loading}
      onClick={() => emit('press')}
      style={props.style}
    >
      {props.icon ? <JxIcon name={props.icon} size="sm" /> : null}
      <span>{props.loading ? 'Working…' : props.label}</span>
      {props.iconRight ? <JxIcon name={props.iconRight} size="sm" /> : null}
    </button>
  ),
  Link: ({ props, emit }: RP) => (
    <a className={cls('jx-link', toneCls(props.tone), props.className)} href={props.href} target={props.external ? '_blank' : undefined} rel={props.external ? 'noopener noreferrer' : undefined} onClick={() => emit('press')}>
      {props.label}
    </a>
  ),
  Icon: ({ props }: RP) => <JxIcon name={String(props.name)} size={props.size} tone={props.tone} className={props.className} />,
  Divider: ({ props }: RP) => <hr className={cls('jx-divider', toneCls(props.tone))} style={{ margin: `${sp(props.spacing ?? 'sm')} 0` }} />,
  Spacer: ({ props }: RP) => <div className="jx-spacer" style={{ flex: props.grow ? 1 : undefined, height: sp(props.size), width: sp(props.size) }} />,
  Chips: ({ props }: RP) => {
    const items: string[] = Array.isArray(props.items) ? props.items : [];
    const fire = useEmitValue({ action: 'sendMessage', valueKey: 'text', ...props });
    return (
      <div className={cls('jx-chips', props.wrap !== false && 'jx-wrap', props.className)}>
        {items.map((c, i) => (
          <button key={i} type="button" className={cls('jx-chip', toneCls(props.tone))} onClick={() => fire(c)}>{c}</button>
        ))}
      </div>
    );
  },
  KeyValue: ({ props }: RP) => (
    <div className={cls('jx-kv', props.inline && 'jx-inline', toneCls(props.tone), props.className)}>
      <span className="jx-kv-label">{props.label}</span>
      <span className="jx-kv-value">{props.value === null || props.value === undefined ? '—' : String(props.value)}</span>
    </div>
  ),
  Table: ({ props }: RP) => {
    const cols: string[] = Array.isArray(props.columns) ? props.columns : [];
    const rows: any[] = Array.isArray(props.rows) ? props.rows : [];
    const keys: string[] | undefined = props.keys;
    return (
      <div className="jx-table-wrap">
        <table className={cls('jx-table', props.dense && 'jx-dense', props.className)}>
          <thead><tr>{cols.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, ri) => {
              const cells = Array.isArray(r) ? r : keys ? keys.map((k) => r?.[k]) : cols.map((c) => r?.[c]);
              return <tr key={ri}>{cells.map((c: any, ci: number) => <td key={ci}>{c === null || c === undefined ? '—' : String(c)}</td>)}</tr>;
            })}
          </tbody>
        </table>
      </div>
    );
  },
  Steps: ({ props }: RP) => {
    const items: any[] = Array.isArray(props.items) ? props.items : [];
    return (
      <ol className={cls('jx-steps', props.className)}>
        {items.map((s, i) => (
          <li key={i} className={cls('jx-step', s?.status && `jx-step-${s.status}`, props.current === i && 'jx-step-current')}>
            <span className="jx-step-n">{s?.status === 'done' ? <JxIcon name="check" size="xs" /> : i + 1}</span>
            <div className="jx-step-body">
              <div className="jx-step-title">{s?.title ?? String(s)}</div>
              {s?.detail ? <div className="jx-step-detail">{s.detail}</div> : null}
            </div>
          </li>
        ))}
      </ol>
    );
  },
  Progress: ({ props }: RP) => (
    <div className={cls('jx-progress', toneCls(props.tone))}>
      {props.label ? <span className="jx-progress-label">{props.label}</span> : null}
      <div className="jx-progress-track"><div className="jx-progress-fill" style={{ width: `${Math.max(0, Math.min(100, Number(props.value) || 0))}%` }} /></div>
    </div>
  ),
  Alert: ({ props }: RP) => (
    <div className={cls('jx-alert', toneCls(props.tone || 'default'), props.className)}>
      <JxIcon name={props.icon || (props.tone === 'warning' ? 'warning' : props.tone === 'success' ? 'check' : 'info')} size="sm" />
      <div>
        {props.title ? <div className="jx-alert-title">{props.title}</div> : null}
        <div className="jx-alert-text">{props.text}</div>
      </div>
    </div>
  ),
  Rating: ({ props }: RP) => {
    const v = Math.max(0, Math.min(5, Number(props.value) || 0));
    return (
      <span className={cls('jx-rating', `jx-size-${props.size || 'sm'}`)} aria-label={`${v} out of 5`}>
        {[0, 1, 2, 3, 4].map((i) => <JxIcon key={i} name="star" size={props.size || 'sm'} className={i < Math.round(v) ? 'jx-star-on' : 'jx-star-off'} />)}
        {props.count != null ? <span className="jx-rating-count">({props.count})</span> : null}
      </span>
    );
  },
  Swatches: ({ props }: RP) => {
    const items: any[] = Array.isArray(props.items) ? props.items : [];
    const emitValue = useEmitValue({ action: 'selectItem', valueKey: 'id', ...props });
    const emit = (e: string) => emitValue(e.replace(/^select:/, ''));
    return (
      <div className={cls('jx-swatches', `jx-size-${props.size || 'md'}`)}>
        {items.map((s, i) => (
          <button key={s?.id ?? i} type="button" title={s?.label} className={cls('jx-swatch', props.selected === s?.id && 'jx-selected')} onClick={() => emit(`select:${s?.id ?? i}`)} style={{ background: s?.hex, backgroundImage: s?.imageUrl ? `url(${s.imageUrl})` : undefined }} />
        ))}
      </div>
    );
  },
  Quantity: ({ props }: RP) => {
    const emitValue = useEmitValue({ action: 'setQuantity', valueKey: 'qty', ...props });
    const emit = (e: string) => emitValue(Number(e.replace(/^change:/, '')));
    const v = Number(props.value) || 0;
    const min = props.min ?? 0, max = props.max ?? 999;
    return (
      <div className={cls('jx-qty', `jx-size-${props.size || 'md'}`)}>
        <button type="button" onClick={() => emit(`change:${Math.max(min, v - 1)}`)} disabled={v <= min}>−</button>
        <span>{v}</span>
        <button type="button" onClick={() => emit(`change:${Math.min(max, v + 1)}`)} disabled={v >= max}>+</button>
      </div>
    );
  },
  Select: ({ props }: RP) => {
    const emitValue = useEmitValue({ action: 'chooseOption', ...props });
    const emit = (e: string) => emitValue(e.replace(/^change:/, ''));
    const opts: any[] = Array.isArray(props.options) ? props.options : [];
    return (
      <label className={cls('jx-select', `jx-size-${props.size || 'md'}`)}>
        {props.label ? <span className="jx-select-label">{props.label}</span> : null}
        <select value={props.value ?? ''} onChange={(e) => emit(`change:${e.target.value}`)}>
          {props.placeholder ? <option value="" disabled>{props.placeholder}</option> : null}
          {opts.map((o, i) => { const val = typeof o === 'string' ? o : o?.value; const lab = typeof o === 'string' ? o : o?.label ?? o?.value; return <option key={i} value={val}>{lab}</option>; })}
        </select>
      </label>
    );
  },
  Markdown: ({ props }: RP) => {
    const text = String(props.text ?? '');
    const blocks = text.split(/\n{2,}/);
    return (
      <div className={cls('jx-md', toneCls(props.tone), props.className)}>
        {blocks.map((b, i) => {
          const lines = b.split('\n');
          const isList = lines.every((l) => /^\s*[-*•]\s+/.test(l));
          const inline = (s: string) => s.split(/(\*\*[^*]+\*\*)/g).map((seg, j) => seg.startsWith('**') ? <strong key={j}>{seg.slice(2, -2)}</strong> : <React.Fragment key={j}>{seg}</React.Fragment>);
          return isList
            ? <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*[-*•]\s+/, ''))}</li>)}</ul>
            : <p key={i}>{inline(b)}</p>;
        })}
      </div>
    );
  },
};

/**
 * `createRenderer` invokes each registry component with the RAW json-render
 * shape — `{ element: { type, props, ... }, children, slots, emit, on,
 * bindings, loading }` — not a flattened `props` key (that flattening is
 * `defineRegistry`'s job, and this file deliberately uses the lighter
 * `createRenderer` API for its simpler `onAction` prop instead of the full
 * state-store/provider wiring `defineRegistry` needs). Every primitive above
 * is written against the flattened `{ props, children, emit, loading }`
 * shape (RP), so adapt here, once, rather than threading `element.props`
 * through all 24 of them. Caught live (2026-09-13): every card crashed with
 * "Cannot read properties of undefined (reading '<prop>')" — `props` was
 * undefined because it was never being unwrapped from `element`.
 */
function adaptForCreateRenderer(map: Record<string, (rp: RP) => React.ReactElement | null>) {
  const out: Record<string, React.ComponentType<any>> = {};
  for (const [name, fn] of Object.entries(map)) {
    out[name] = ({ element, children, slots, emit, loading }: any) => fn({ props: element?.props || {}, children, slots, emit, loading });
  }
  return out;
}

/** The renderer bound to the platform catalog. */
export const CatalogRenderer = createRenderer(catalog as any, adaptForCreateRenderer(components) as any);

export interface CardRendererProps {
  /** Template spec from Mongo (or platform default). */
  template: Spec;
  /** Change this to force the renderer to re-seed its state (e.g. card id + version). */
  stateKey?: string;
  /** Server-joined data for this card instance. */
  state: Record<string, unknown>;
  /** Tenant card settings exposed at `/settings`. */
  settings?: Record<string, unknown>;
  onAction?: (name: string, params?: Record<string, unknown>) => void;
  loading?: boolean;
  className?: string;
}

/**
 * Renders one card: template + state → DOM. Wrap it in a `.jx-root` so the
 * theme variables and base styles apply.
 */
export function CardRenderer({ template, state, settings, onAction, loading, className, stateKey }: CardRendererProps) {
  const merged = useMemo(() => ({ ...(template.state || {}), ...state, settings: settings || {} }), [template, state, settings]);
  return (
    <div className={cls('jx-root', className)}>
      <CatalogRenderer key={stateKey} spec={template} state={merged} onAction={onAction} loading={loading} />
    </div>
  );
}

export function CardInstanceRenderer({ card, template, ...rest }: { card: CardInstance; template: Spec } & Omit<CardRendererProps, 'template' | 'state'>) {
  return <CardRenderer template={template} state={card.state} {...rest} />;
}

export type { Spec };
