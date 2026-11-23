import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dataDir, file, bumpVersion } from './paths.js';

/**
 * A tiny per-user process that holds the unwrapped vault key IN MEMORY ONLY while the vault is unlocked.
 * It never sees the password (clients derive the key and hand it over) and never writes the key anywhere.
 * It locks and exits after the idle timeout or on request. The socket is user-only (0600 in a 0700 directory;
 * a default-DACL named pipe on Windows). Any process running as the same user can still ask it for the key,
 * which is the documented limit of this design.
 */

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cli/index.js');

export function socketPath() {
  if (process.platform === 'win32') return `\\\\.\\pipe\\secretmgr-${crypto.createHash('sha1').update(dataDir()).digest('hex').slice(0, 16)}`;
  const direct = path.join(dataDir(), 'agent.sock');
  if (Buffer.byteLength(direct) < 100) return direct;
  // sun_path is limited to ~104 bytes; fall back to a private per-user directory.
  const dir = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), `secretmgr-${process.getuid?.() ?? 'u'}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.getuid && fs.statSync(dir).uid !== process.getuid()) throw new Error(`${dir} is not owned by you; refusing to use it`);
  fs.chmodSync(dir, 0o700);
  return path.join(dir, `${crypto.createHash('sha1').update(dataDir()).digest('hex').slice(0, 12)}.sock`);
}

// ------------------------------------------------------------------ client
function request(msg, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(v);
    };
    const sock = net.connect(socketPath());
    const timer = setTimeout(() => finish(null), timeoutMs);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify(msg) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0) {
        try {
          finish(JSON.parse(buf.slice(0, i)));
        } catch {
          finish(null);
        }
      }
    });
    sock.on('error', () => finish(null));
    sock.on('close', () => finish(null));
  });
}

/** null when no agent is running (which means locked). */
export const agentStatus = () => request({ op: 'status' });

export async function fetchKey({ touch = true } = {}) {
  const r = await request({ op: 'get', touch });
  return r?.ok ? Buffer.from(r.key, 'base64') : null;
}

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return false;
}

/** Start the agent if it is not already running, then give it the key. */
export async function putKey(key, idleMin) {
  if (!(await agentStatus())) {
    spawn(process.execPath, [CLI, 'agent'], { detached: true, stdio: 'ignore', env: process.env }).unref();
    if (!(await waitFor(agentStatus, 5000))) throw new Error('Could not start the key agent');
  }
  const r = await request({ op: 'put', key: key.toString('base64'), idleMin });
  if (!r?.ok) throw new Error('The key agent refused the key');
}

export const setIdle = (idleMin) => request({ op: 'idle', idleMin });

export async function lockAgent(actor = 'you') {
  const r = await request({ op: 'lock', actor });
  return Boolean(r?.ok);
}

// ------------------------------------------------------------------ server
export async function runKeyAgent() {
  const sp = socketPath();
  if (await agentStatus()) return; // one is already running
  if (process.platform !== 'win32') fs.rmSync(sp, { force: true });
  process.umask(0o077);

  let key = null;
  let idleMs = 0;
  let timer = null;
  let lockedAt = null;

  const lockNow = async (actor) => {
    if (key) {
      key.fill(0);
      key = null;
    }
    clearTimeout(timer);
    // Locking ends agent activations and makes terminals clear their variables on the next prompt.
    try {
      const st = await import('./state.js');
      st.clearActive(actor);
      const { audit } = await import('./audit.js');
      audit({ actor, action: 'lock', result: 'ok' });
    } catch {
      /* the key is gone either way */
    }
    bumpVersion();
  };
  const arm = () => {
    clearTimeout(timer);
    if (idleMs > 0 && key) {
      lockedAt = Date.now() + idleMs;
      timer = setTimeout(() => lockNow('idle timeout').finally(() => shutdown()), idleMs);
    } else lockedAt = null;
  };

  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('data', async (d) => {
      buf += d;
      if (buf.length > 4096) return sock.destroy();
      const i = buf.indexOf('\n');
      if (i < 0) return;
      let msg;
      try {
        msg = JSON.parse(buf.slice(0, i));
      } catch {
        return sock.destroy();
      }
      buf = '';
      const reply = (o) => sock.end(JSON.stringify(o) + '\n');
      switch (msg.op) {
        case 'status':
          return reply({ ok: true, unlocked: Boolean(key), idleMin: idleMs / 60_000, lockInSec: key && lockedAt ? Math.max(0, Math.round((lockedAt - Date.now()) / 1000)) : null });
        case 'put': {
          const k = Buffer.from(String(msg.key || ''), 'base64');
          if (k.length !== 32) return reply({ ok: false });
          if (key) key.fill(0);
          key = k;
          idleMs = Math.max(0, Number(msg.idleMin) || 0) * 60_000;
          arm();
          return reply({ ok: true });
        }
        case 'get':
          if (!key) return reply({ ok: false });
          if (msg.touch !== false) arm(); // real use pushes the idle deadline back; a dashboard poll does not
          return reply({ ok: true, key: key.toString('base64') });
        case 'idle':
          idleMs = Math.max(0, Number(msg.idleMin) || 0) * 60_000;
          arm();
          return reply({ ok: true });
        case 'lock':
          reply({ ok: true });
          await lockNow(msg.actor === 'agent' ? 'agent' : 'you');
          return shutdown();
        default:
          return reply({ ok: false });
      }
    });
  });

  const shutdown = () => {
    server.close();
    if (process.platform !== 'win32') fs.rmSync(sp, { force: true });
    setTimeout(() => process.exit(0), 50);
  };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => (key && key.fill(0), shutdown()));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sp, resolve);
  });
  if (process.platform !== 'win32') fs.chmodSync(sp, 0o600);
  fs.writeFileSync(file('agent.pid'), String(process.pid), { mode: 0o600 });
}
