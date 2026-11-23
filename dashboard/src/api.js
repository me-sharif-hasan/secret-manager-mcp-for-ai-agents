const KEY = 'secretmgr-token';
const SESSION = 'secretmgr-session';

export const setSession = (id) => (id ? sessionStorage.setItem(SESSION, id) : sessionStorage.removeItem(SESSION));

/** The CLI opens the dashboard as /#token=...; keep it in sessionStorage and strip it from the URL bar. */
export function initToken() {
  const m = location.hash.match(/token=([\w-]+)/);
  const screen = location.hash.match(/screen=([a-z]+)/);
  const theme = location.hash.match(/theme=(dark|light)/);
  const mode = location.hash.match(/mode=([a-z]+)/);
  if (mode) sessionStorage.setItem('sm-mode', mode[1]); // 'unlock': a short-lived window opened for an agent
  if (theme) document.documentElement.dataset.theme = theme[1];
  if (screen) sessionStorage.setItem('sm-screen', screen[1]); // deep link: /#token=...&screen=envs
  if (m) {
    sessionStorage.setItem(KEY, m[1]);
    history.replaceState(null, '', location.pathname + location.search);
  }
  return sessionStorage.getItem(KEY);
}

export class AuthError extends Error {}
/** The server wants the master password: no session, or the session ended (sign-out, lock, restart). */
export class LoginRequired extends Error {}

export async function api(path, { method = 'GET', body, raw } = {}) {
  const token = sessionStorage.getItem(KEY);
  const res = await fetch('/api' + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(sessionStorage.getItem(SESSION) ? { 'X-Session': sessionStorage.getItem(SESSION) } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    const why = await res.clone().json().catch(() => ({}));
    if (why.code === 'login') {
      setSession(null);
      throw new LoginRequired(why.error);
    }
    throw new AuthError('This dashboard link is no longer valid');
  }
  if (raw) {
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res;
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}

export function ago(iso) {
  if (!iso) return '-';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
