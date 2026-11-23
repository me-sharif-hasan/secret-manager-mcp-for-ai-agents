import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import * as vault from '../core/vault.js';
import * as st from '../core/state.js';
import { audit, readAudit } from '../core/audit.js';
import { safeEqual } from '../core/crypto.js';
import { keyBackendName, getMasterKey } from '../core/keystore.js';
import { installShells } from '../shell/install.js';
import { initScript, } from '../shell/init.js';
import { openTerminal } from '../shell/terminal.js';
import { guidanceText } from '../core/guidance.js';

/**
 * Local dashboard API. Defences: bound to 127.0.0.1 by the caller, bearer token on every /api call,
 * Host and Origin checks against DNS rebinding and cross-site requests, reveal rate limit.
 */
export async function buildApp({ token, port, staticDir } = {}) {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  app.addHook('onRequest', async (req, reply) => {
    if (port && !allowedHosts.has(req.headers.host)) return reply.code(403).send({ error: 'Bad Host header' });
    if (!req.url.startsWith('/api/')) return;
    const origin = req.headers.origin;
    if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) return reply.code(403).send({ error: 'Cross-origin request refused' });
    if (req.url === '/api/health') return;
    const auth = req.headers.authorization || '';
    if (!token || !safeEqual(auth.replace(/^Bearer /, ''), token)) return reply.code(401).send({ error: 'Missing or invalid token. Open the dashboard with `secretmgr dashboard`.' });
  });

  app.setErrorHandler((err, _req, reply) => {
    const status = err.status || err.statusCode || 500;
    reply.code(status).send({ error: status >= 500 ? `Internal error: ${err.message}` : err.message });
  });

  // ------------------------------------------------------------- state
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/state', async () => {
    const s = st.getState();
    let backend = null;
    try {
      getMasterKey();
      backend = keyBackendName();
    } catch {
      /* vault not initialised yet */
    }
    return {
      killed: s.killed,
      defaultGroup: s.defaultGroup,
      terminalDefaultEnv: s.terminalDefaultEnv,
      active: s.active,
      approvals: st.pendingApprovals(),
      groups: vault.vaultExists() ? vault.listGroups() : [],
      keyBackend: backend,
    };
  });

  app.post('/api/kill', async (req) => ({ killed: st.setKilled(Boolean(req.body?.on), 'you') }));
  app.put('/api/terminal-default', async (req) => {
    st.setTerminalDefaultEnv(String(req.body?.env || ''));
    return { ok: true };
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
