import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import * as vault from '../core/vault.js';
import * as st from '../core/state.js';
import { audit, readAudit } from '../core/audit.js';
import { safeEqual, randomToken } from '../core/crypto.js';
import { keyBackendName, getMasterKey, acquireKey } from '../core/keystore.js';
import * as security from '../core/security.js';
import { LockedError, WrongPasswordError, requiresSetup, isProtected } from '../core/lockbox.js';
import { installShells } from '../shell/install.js';
import { initScript, } from '../shell/init.js';
import { openTerminal } from '../shell/terminal.js';
import { guidanceText } from '../core/guidance.js';

/**
 * Local dashboard API. Defences: bound to 127.0.0.1 by the caller, bearer token on every /api call,
 * Host and Origin checks against DNS rebinding and cross-site requests, reveal rate limit.
 */
export async function buildApp({ token, port, staticDir, onActivity } = {}) {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  // The link's token only gets a browser to the sign-in page. Everything else needs a session, and a session is
  // only issued for the master password. So opening the dashboard link never shows the vault, whether or not the
  // vault happens to be unlocked. Sessions live in this process's memory and die with it.
  const SESSION_MAX_MS = 12 * 3600_000;
  const sessions = new Map();
  const OPEN = new Set(['GET /api/state', 'POST /api/security/login', 'POST /api/security/enable']);
  const sessionOf = (req) => {
    const id = req.headers['x-session'];
    const at = typeof id === 'string' ? sessions.get(id) : undefined;
    if (at && Date.now() - at < SESSION_MAX_MS) return id;
    if (at) sessions.delete(id);
    return null;
  };
  const startSession = () => {
    const id = randomToken();
    sessions.set(id, Date.now());
    return id;
  };

  app.addHook('onRequest', async (req, reply) => {
    onActivity?.();
    if (port && !allowedHosts.has(req.headers.host)) return reply.code(403).send({ error: 'Bad Host header' });
    if (!req.url.startsWith('/api/')) return;
    const origin = req.headers.origin;
    if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) return reply.code(403).send({ error: 'Cross-origin request refused' });
    if (req.url === '/api/health') return;
    const auth = req.headers.authorization || '';
    if (!token || !safeEqual(auth.replace(/^Bearer /, ''), token)) return reply.code(401).send({ error: 'Missing or invalid token. Open the dashboard with `secretmgr dashboard`.', code: 'token' });
    const route = `${req.method} ${req.url.split('?')[0]}`;
    if (!OPEN.has(route)) {
      if (requiresSetup()) return reply.code(403).send({ error: 'Set a master password first.', code: 'setup' });
      if (isProtected() && !sessionOf(req)) return reply.code(401).send({ error: 'Sign in with your master password.', code: 'login' });
    }
  });

  // The vault key is fetched from the key agent per request and dropped afterwards, so locking takes effect at once.
  // A locked vault is not an error here: routes that need the key get LockedError (HTTP 423) when they ask for it.
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    try {
      // The dashboard's own status polls must not count as vault activity, or an open tab would defeat auto-lock.
      const poll = req.method === 'GET' && (req.url === '/api/state' || req.url === '/api/security');
      req.releaseKey = await acquireKey({ touch: !poll });
    } catch (e) {
      if (!(e instanceof LockedError)) throw e;
    }
  });
  app.addHook('onResponse', async (req) => req.releaseKey?.());

  app.setErrorHandler((err, _req, reply) => {
    const status = err.status || err.statusCode || 500;
    reply.code(status).send({ error: status >= 500 ? `Internal error: ${err.message}` : err.message });
  });

  // ------------------------------------------------------------- state
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/state', async (req) => {
    const s = st.getState();
    const prot = isProtected();
    const setup = requiresSetup();
    let backend = null;
    let groups = [];
    let locked = false;
    if (!setup) {
      try {
        getMasterKey();
        backend = keyBackendName();
        groups = vault.vaultExists() ? vault.listGroups() : [];
      } catch (e) {
        if (e instanceof LockedError) {
          locked = true;
          backend = 'master password (locked)';
        } /* else: vault not initialised yet */
      }
    }
    if (locked) sessions.clear(); // a locked vault ends every dashboard session
    const loggedIn = prot ? Boolean(sessionOf(req)) && !locked : !setup;
    const base = {
      locked,
      needsSetup: setup,
      protected: prot,
      loggedIn,
      unlockRequested: Boolean(s.unlockRequestedAt && Date.now() - s.unlockRequestedAt < 10 * 60_000),
      killed: s.killed,
    };
    if (!loggedIn) return base; // nothing about the vault until the master password has been entered
    return {
      ...base,
      defaultGroup: s.defaultGroup,
      terminalDefaultEnv: s.terminalDefaultEnv,
      active: s.active,
      approvals: st.pendingApprovals(),
      groups,
      keyBackend: backend,
    };
  });

  app.post('/api/kill', async (req) => ({ killed: st.setKilled(Boolean(req.body?.on), 'you') }));
  app.put('/api/terminal-default', async (req) => {
    st.setTerminalDefaultEnv(String(req.body?.env || ''));
    return { ok: true };
  });

  // ---------------------------------------------------------- security
  // Online guessing is throttled; offline guessing is limited only by scrypt and the password itself.
  let fails = 0;
  let blockedUntil = 0;
  const attempt = async (fn) => {
    const wait = Math.ceil((blockedUntil - Date.now()) / 1000);
    if (wait > 0) throw Object.assign(new Error(`Too many wrong passwords. Try again in ${wait}s.`), { status: 429 });
    try {
      const r = await fn();
      fails = 0;
      return r;
    } catch (e) {
      if (e instanceof WrongPasswordError) {
        fails++;
        if (fails >= 5) blockedUntil = Date.now() + Math.min(300_000, 2 ** (fails - 4) * 5_000);
        audit({ actor: 'you', action: 'unlock', result: 'wrong password' });
      }
      throw e;
    }
  };
  const pw = (v, name) => {
    if (typeof v !== 'string' || !v || v.length > 1024) throw Object.assign(new Error(`${name} is required`), { status: 400 });
    return v;
  };
  app.get('/api/security', async () => security.securityStatus());
  app.post('/api/security/enable', async (req) => {
    await security.enableProtection(pw(req.body?.password, 'Password'));
    return { ...(await security.securityStatus()), session: startSession() };
  });
  // Sign in: verifies the master password, unlocks the vault if it is locked, and starts a dashboard session.
  app.post('/api/security/login', async (req) => {
    if (!isProtected()) throw Object.assign(new Error('No master password is set'), { status: 409 });
    await attempt(() => security.unlock(pw(req.body?.password, 'Password')));
    audit({ actor: 'you', action: 'dashboard_login', result: 'ok' });
    return { session: startSession() };
  });
  app.post('/api/security/logout', async (req) => {
    const id = req.headers['x-session'];
    if (typeof id === 'string') sessions.delete(id);
    return { ok: true };
  });
  // Lock the vault and end every dashboard session.
  app.post('/api/security/lock', async () => {
    sessions.clear();
    await security.lock();
    return security.securityStatus();
  });
  app.put('/api/security/password', async (req) => {
    await attempt(() => security.changePassword(pw(req.body?.current, 'Current password'), pw(req.body?.next, 'New password')));
    return { ok: true };
  });
  app.put('/api/security/idle', async (req) => {
    await security.setIdleMin(req.body?.minutes);
    return security.securityStatus();
  });

  // ------------------------------------------------------------ groups
  app.post('/api/groups', async (req, reply) => {
    const r = vault.createGroup(String(req.body?.name || ''), { envs: req.body?.envs });
    audit({ actor: 'you', action: 'create_group', group: r.name, result: 'ok' });
    if (!st.getState().defaultGroup) st.setDefaultGroup(r.name);
    return reply.code(201).send(r);
  });
  app.get('/api/groups/:g', async (req) => {
    const view = vault.viewGroup(req.params.g);
    for (const [env, e] of Object.entries(view.envs)) e.guidanceText = guidanceText(env, e.guidance, e.enforce);
    return view;
  });
  app.put('/api/groups/:g/default', async (req) => {
    vault.viewGroup(req.params.g);
    st.setDefaultGroup(req.params.g);
    return { ok: true };
  });

  app.put('/api/groups/:g/envs/:env', async (req) => {
    const r = vault.setEnvSettings(req.params.g, req.params.env, req.body || {});
    audit({ actor: 'you', action: 'env_settings', group: req.params.g, env: req.params.env, result: 'ok' });
    if (r.allow === false) st.deactivate(req.params.env, 'you');
    return r;
  });
  app.post('/api/groups/:g/envs', async (req, reply) => {
    const r = vault.addEnv(req.params.g, String(req.body?.name || ''), { cloneFrom: req.body?.cloneFrom });
    audit({ actor: 'you', action: 'create_env', group: req.params.g, env: req.body.name, result: 'ok' });
    return reply.code(201).send(r);
  });

  app.delete('/api/groups/:g/envs/:env', async (req) => {
    const { g, env } = req.params;
    const r = vault.deleteEnv(g, env);
    st.afterEnvDeleted(g, env, r.remaining[0]);
    audit({ actor: 'you', action: 'delete_env', group: g, env, result: `${r.removedValues} values removed` });
    return r;
  });

  // --------------------------------------------------------- variables
  app.post('/api/groups/:g/vars', async (req, reply) => {
    const { key, values, access } = req.body || {};
    const r = vault.setVar(req.params.g, String(key || ''), { values, access });
    audit({ actor: 'you', action: r.isNew ? 'create_var' : 'edit_var', group: req.params.g, key, result: 'ok' });
    return reply.code(201).send(r);
  });
  app.put('/api/groups/:g/vars/:key', async (req) => {
    const r = vault.setVar(req.params.g, req.params.key, req.body || {});
    audit({ actor: 'you', action: 'edit_var', group: req.params.g, key: req.params.key, result: 'ok' });
    return r;
  });
  app.delete('/api/groups/:g/vars/:key', async (req) => {
    vault.deleteVar(req.params.g, req.params.key);
    audit({ actor: 'you', action: 'delete_var', group: req.params.g, key: req.params.key, result: 'ok' });
    return { ok: true };
  });
  app.put('/api/groups/:g/vars/:key/access', async (req) => {
    const { env, level } = req.body || {};
    vault.setAccess(req.params.g, req.params.key, env, level);
    audit({ actor: 'you', action: 'set_access', group: req.params.g, key: req.params.key, env, result: level });
    return { ok: true };
  });

  const revealLog = [];
  app.post('/api/groups/:g/vars/:key/reveal', async (req, reply) => {
    const now = Date.now();
    while (revealLog.length && now - revealLog[0] > 60_000) revealLog.shift();
    if (revealLog.length >= 30) return reply.code(429).send({ error: 'Too many reveals. Wait a minute.' });
    revealLog.push(now);
    const env = String(req.body?.env || '');
    const value = vault.reveal(req.params.g, req.params.key, env);
    audit({ actor: 'you', action: 'reveal', group: req.params.g, key: req.params.key, env, result: 'dashboard' });
    return { value };
  });

  // ------------------------------------------------------------- .env
  app.post('/api/groups/:g/import', async (req) => {
    const { env, text, access, dryRun } = req.body || {};
    const r = vault.importEnv(req.params.g, String(env || ''), String(text || ''), { access: access || 'use', dryRun: Boolean(dryRun) });
    if (!dryRun) audit({ actor: 'you', action: 'import_env', group: req.params.g, env, result: `${r.written} written` });
    return r;
  });
  app.get('/api/groups/:g/export', async (req, reply) => {
    const env = String(req.query?.env || '');
    const out = vault.exportEnv(req.params.g, env);
    audit({ actor: 'you', action: 'export_env', group: req.params.g, env, result: 'dashboard' });
    return reply.type('text/plain; charset=utf-8').header('Content-Disposition', `attachment; filename=".env.${env}"`).send(out);
  });

  // ------------------------------------------------------------- agent
  app.post('/api/agent/activate', async (req) => {
    const { group, env, primary } = req.body || {};
    if (requiresSetup()) throw Object.assign(new Error('Set a master password before agents can use secrets.'), { status: 403 });
    const view = vault.viewGroup(group);
    const settings = view.envs[env];
    if (!settings) throw Object.assign(new Error(`Unknown environment "${env}"`), { status: 404 });
    if (!settings.allow) throw Object.assign(new Error(`Agent activation of "${env}" is turned off. Enable it under Environments first.`), { status: 403 });
    return st.activate(group, env, { primary: Boolean(primary), expiryMin: settings.expiryMin, actor: 'you' });
  });
  app.post('/api/agent/deactivate', async (req) => ({ deactivated: st.deactivate(String(req.body?.env || ''), 'you') }));
  app.put('/api/agent/primary', async (req) => {
    st.setPrimary(String(req.body?.env || ''));
    return { ok: true };
  });
  app.post('/api/approvals/:id', async (req) => {
    const pending = st.getState().pending[req.params.id];
    if (!pending) throw Object.assign(new Error('No such pending request'), { status: 404 });
    const settings = vault.viewGroup(pending.group).envs[pending.env];
    return { status: st.decideApproval(req.params.id, Boolean(req.body?.approve), { expiryMin: settings?.expiryMin ?? null }) };
  });

  // ------------------------------------------------------- audit, shell
  app.get('/api/audit', async (req) => readAudit({ actor: req.query?.actor, limit: 300 }));
  app.get('/api/shell/snippet', async (req) => {
    const shell = String(req.query?.shell || 'bash');
    return { shell, script: initScript(shell === 'cmd' ? 'bash' : shell), line: { bash: 'eval "$(secretmgr shell-init bash)"', zsh: 'eval "$(secretmgr shell-init zsh)"', fish: 'secretmgr shell-init fish | source', pwsh: 'secretmgr shell-init pwsh | Out-String | Invoke-Expression', cmd: 'secretmgr install --shell cmd' }[shell] };
  });
  app.post('/api/shell/install', async (req) => {
    const report = installShells({ shells: req.body?.shells });
    audit({ actor: 'you', action: 'install_shell_hooks', result: report.map((r) => r.shell).join(',') });
    return { installed: report };
  });
  app.post('/api/shell/open', async (req) => {
    const { group, env } = req.body || {};
    vault.viewGroup(group);
    if (st.getState().killed) throw Object.assign(new Error('The kill switch is on.'), { status: 403 });
    audit({ actor: 'you', action: 'open_shell', group, env, result: 'requested' });
    return openTerminal({ env: String(env), group });
  });

  // ------------------------------------------------------------ static
  const dir = staticDir && fs.existsSync(path.join(staticDir, 'index.html')) ? staticDir : null;
  if (dir) {
    await app.register(fastifyStatic, { root: dir, wildcard: false });
    app.get('/*', async (req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  } else {
    app.get('/', async (_req, reply) => reply.type('text/html').send('<h1>secretmgr API is running</h1><p>The dashboard UI has not been built. Run <code>npm run build:dashboard</code>.</p>'));
  }
  return app;
}
