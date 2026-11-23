import { useEffect, useState } from 'react';
import { useApp } from '../ctx.jsx';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { Field, OutSelect, Row, Tag } from '../ui.jsx';
import { checkStrength } from '../../../src/core/strength.js';

const IDLE = [
  ['0', 'Never'],
  ['5', 'After 5 minutes'],
  ['15', 'After 15 minutes'],
  ['30', 'After 30 minutes'],
  ['60', 'After 1 hour'],
  ['240', 'After 4 hours'],
];

// 54 unambiguous letters and digits, four groups of five joined by hyphens: about 115 bits, and it always
// contains a capital, a small letter, a number and a special character (the hyphen).
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export function generatePassword() {
  for (;;) {
    const chars = [];
    while (chars.length < 20) {
      const [b] = crypto.getRandomValues(new Uint8Array(1));
      if (b < 216) chars.push(ALPHABET[b % 54]); // 216 = 4 x 54: no modulo bias
    }
    const pw = [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join('')).join('-');
    if (checkStrength(pw).ok) return pw;
  }
}

export function Meter({ password }) {
  if (!password) return null;
  const s = checkStrength(password);
  const pct = Math.min(100, Math.round((s.bits / 100) * 100));
  const kind = !s.ok ? 'bad' : s.bits >= 70 ? 'ok' : 'warn';
  return (
    <div>
      <div className="meter" aria-hidden="true">
        <i className={kind} style={{ width: `${Math.max(6, pct)}%` }} />
      </div>
      <p className="sub" style={{ margin: '4px 16px 0', color: s.ok ? undefined : 'var(--error)' }}>
        {!s.ok
          ? s.reason
          : s.bits >= 70
            ? `About ${s.bits} bits (rough estimate). Good.`
            : `Meets the rules, but only about ${s.bits} bits. Someone holding your vault files could guess it offline. Longer, or the generator, is much stronger.`}
      </p>
    </div>
  );
}

/** New-password pair with a strength meter and a generator. Reports the password up only when it is acceptable and repeated. */
export function NewPassword({ idPrefix, onValid }) {
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [show, setShow] = useState(false);
  const report = (a, b) => onValid(a && a === b && checkStrength(a).ok ? a : null);
  return (
    <>
      <Field id={`${idPrefix}-new`} label="New master password" hint="At least 8 characters with a capital, a small letter, a number and a special character" type={show ? 'text' : 'password'} value={pw} bg="var(--surface-lowest)" onChange={(v) => { setPw(v); report(v, again); }} />
      <Meter password={pw} />
      <Field id={`${idPrefix}-again`} label="Repeat it" type={show ? 'text' : 'password'} value={again} bg="var(--surface-lowest)" error={again && pw !== again ? 'The two passwords differ' : ''} onChange={(v) => { setAgain(v); report(pw, v); }} />
      <div className="actions-row">
        <button
          className="btn tonal icon"
          onClick={() => {
            const g = generatePassword();
            setPw(g);
            setAgain(g);
            setShow(true);
            report(g, g);
          }}
        >
          <Icon name="key" />
          Generate a random one
        </button>
        <button className="btn text" onClick={() => setShow(!show)}>
          {show ? 'Hide' : 'Show'}
        </button>
      </div>
    </>
  );
}

/** First-time setup: a master password is required before agents can use any secret. */
export function SetupCard({ onDone }) {
  const { notify } = useApp();
  const [fresh, setFresh] = useState(null);
  const [ack, setAck] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      await api('/security/enable', { method: 'POST', body: { password: fresh } });
      notify('Master password set. The vault is unlocked for this session.');
      onDone();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card" style={{ maxWidth: 560, width: '100%' }}>
      <div className="kv">
        <h3>Set a master password</h3>
        <Tag kind="warn" icon="lock_open">
          Required
        </Tag>
      </div>
      <p className="muted">
        The vault key is wrapped by your password and stored nowhere else, so a copy of the vault and keychain files is useless without it. Agents cannot use any secret until this is set.
      </p>
      <NewPassword idPrefix="set" onValid={setFresh} />
      <label className="kv" style={{ cursor: 'pointer' }}>
        <span>
          I understand there is no recovery
          <span className="sub">If I forget this password the vault cannot be opened. Write it down somewhere safe.</span>
        </span>
        <button className="switch" role="switch" aria-checked={ack} aria-label="I understand there is no recovery" onClick={() => setAck(!ack)} />
      </label>
      {err && <p style={{ color: 'var(--error)' }}>{err}</p>}
      <div className="actions-row">
        <button className="btn filled icon" disabled={!fresh || !ack || busy} onClick={save}>
          <Icon name="lock" />
          Set master password
        </button>
      </div>
    </div>
  );
}

export default function Security() {
  const { refresh, notify, guard } = useApp();
  const [sec, setSec] = useState(null);
  const [fresh, setFresh] = useState(null);
  const [ack, setAck] = useState(false);
  const [current, setCurrent] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetKey, setResetKey] = useState(0);

  const reload = () => api('/security').then(setSec).catch(guard);
  useEffect(() => {
    reload();
    const t = setInterval(reload, 5000); // the idle countdown and agent-side locks change without any click
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn, done) => {
    setBusy(true);
    setErr('');
    try {
      await fn();
      if (done) notify(done);
      setResetKey((k) => k + 1);
      setFresh(null);
      setAck(false);
      setCurrent('');
      await reload();
      refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!sec) return <p className="empty">Loading</p>;

  if (!sec.protected) return <SetupCard onDone={() => { reload(); refresh(); }} />;

  return (
    <>
      {sec.leftoverKey && (
        <div className="banner warn">
          <Icon name="warning" />
          <span className="t">A plain copy of the vault key is still stored on this machine, which defeats the password. Lock and unlock once to remove it.</span>
        </div>
      )}
      <div className="grid3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <div className="card">
          <div className="kv">
            <h3>Master password</h3>
            <Tag kind={sec.unlocked ? 'ok' : 'bad'} icon={sec.unlocked ? 'lock_open' : 'lock'}>
              {sec.unlocked ? 'Unlocked' : 'Locked'}
            </Tag>
          </div>
          <p className="muted">The key lives in memory only while unlocked. Locking ends agent activations and makes your terminals clear their variables on the next prompt.</p>
          <Row label="Lock automatically" sub={sec.lockInSec != null && sec.idleMin ? `Locks in about ${Math.max(1, Math.round(sec.lockInSec / 60))} min if idle` : 'When nothing has used the vault for this long'}>
            <OutSelect value={String(sec.idleMin)} options={IDLE} label="Lock automatically" onChange={(v) => api('/security/idle', { method: 'PUT', body: { minutes: Number(v) } }).then(() => { notify('Auto-lock updated'); reload(); }).catch((e) => notify(e.message))} />
          </Row>
          <div className="actions-row">
            <button className="btn danger icon" disabled={!sec.unlocked || busy} onClick={() => run(() => api('/security/lock', { method: 'POST', body: {} }), 'Locked')}>
              <Icon name="lock" />
              Lock now
            </button>
          </div>
        </div>

        <div className="card">
          <h3>Change master password</h3>
          <p className="muted">Your vault data is not re-encrypted; only the key wrapper changes, so this is instant. The old password stops working.</p>
          <Field id="cur" label="Current password" type="password" value={current} bg="var(--surface-lowest)" onChange={setCurrent} />
          <NewPassword key={resetKey} idPrefix="chg" onValid={setFresh} />
          {err && <p style={{ color: 'var(--error)' }}>{err}</p>}
          <div className="actions-row">
            <button className="btn filled icon" disabled={!current || !fresh || busy} onClick={() => run(() => api('/security/password', { method: 'PUT', body: { current, next: fresh } }), 'Master password changed')}>
              <Icon name="key" />
              Change password
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
