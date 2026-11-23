import { useEffect, useState } from 'react';
import { Icon } from './icons.jsx';

export const LEVELS = ['none', 'use', 'write'];
export const GUIDANCE = [
  ['read_only', 'Read-only'],
  ['write', 'Write'],
  ['full', 'Full'],
];
export const guidanceLabel = Object.fromEntries(GUIDANCE);
export const cx = (...a) => a.filter(Boolean).join(' ');

export function Seg({ items, value, onChange, dots }) {
  return (
    <div className="seg" role="group">
      {items.map((x) => (
        <button key={x} className="state" aria-current={x === value} onClick={() => onChange(x)}>
          {x === value ? <Icon name="check" /> : dots ? <span className={`env-dot ${x}`} /> : null}
          {x}
        </button>
      ))}
    </div>
  );
}

/** Colour-coded access dropdown: none / use / write. */
export function AccSelect({ value, onChange, dead, label }) {
  const v = value ?? 'none';
  return (
    <span className={cx('acc', v, dead && 'dead')} onClick={(e) => e.stopPropagation()}>
      <select aria-label={label} value={v} onChange={(e) => onChange(e.target.value)}>
        {LEVELS.map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </select>
      <Icon name="arrow_drop_down" />
    </span>
  );
}

export function OutSelect({ value, options, onChange, wide, label, disabled, id }) {
  return (
    <span className={cx('outsel', wide && 'wide')}>
      <select id={id} aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => {
          const [v, l] = Array.isArray(o) ? o : [o, o];
          return (
            <option key={v} value={v}>
              {l}
            </option>
          );
        })}
      </select>
      <Icon name="arrow_drop_down" />
    </span>
  );
}

export function Switch({ checked, onChange, label, disabled }) {
  return <button className="switch" role="switch" aria-checked={Boolean(checked)} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} />;
}

export function Tag({ kind, icon, children }) {
  return (
    <span className={cx('tag', kind)}>
      {icon && <Icon name={icon} />}
      {children}
    </span>
  );
}

export const levelKind = (l) => (l === 'none' ? 'bad' : l === 'use' ? 'ok' : 'warn');

/** A kv row: label (+ optional sub-label) on the left, control on the right. Same height everywhere so cards line up. */
export function Row({ label, sub, off, children }) {
  return (
    <div className={cx('kv', off && 'off')}>
      <span>
        {label}
        {sub && <span className="sub">{sub}</span>}
      </span>
      {children}
    </div>
  );
}

export function Dialog({ title, icon, children, actions, onClose, wide }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} style={wide ? { maxWidth: 520 } : undefined}>
        {icon && <Icon name={icon} className="big" />}
        <h2>{title}</h2>
        {children}
        <div className="actions">{actions}</div>
      </div>
    </div>
  );
}

export function Confirm({ title, icon, body, confirmLabel, danger, onCancel, onConfirm, typeToConfirm }) {
  const [typed, setTyped] = useState('');
  const blocked = typeToConfirm && typed !== typeToConfirm;
  return (
    <Dialog
      title={title}
      icon={icon}
      onClose={onCancel}
      actions={
        <>
          <button className="btn text" onClick={onCancel}>
            Cancel
          </button>
          <button className={cx('btn', danger ? 'danger-filled' : 'filled')} disabled={blocked} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="muted">{body}</p>
      {typeToConfirm && (
        <div className="tf" style={{ marginTop: 6 }}>
          <label htmlFor="confirm-text" style={{ background: 'var(--surface-low)' }}>
            Type {typeToConfirm} to confirm
          </label>
          <input id="confirm-text" autoFocus autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </div>
      )}
    </Dialog>
  );
}

export function Field({ id, label, value, onChange, type = 'text', placeholder, mono, error, hint, autoFocus, bg }) {
  return (
    <div>
      <div className="tf">
        <label htmlFor={id} style={bg ? { background: bg } : undefined}>
          {label}
        </label>
        <input id={id} type={type} value={value} placeholder={placeholder} autoComplete="off" autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} style={mono ? { fontFamily: 'var(--mono)', fontSize: 13 } : undefined} />
      </div>
      {(error || hint) && <p className="sub" style={{ margin: '4px 16px 0', color: error ? 'var(--error)' : undefined }}>{error || hint}</p>}
    </div>
  );
}
