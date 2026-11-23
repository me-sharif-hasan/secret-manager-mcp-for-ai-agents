import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { file } from './paths.js';
import { randomKey } from './crypto.js';

const SERVICE = 'secretmgr';
const ACCOUNT = 'master-key';

function run(cmd, args, input) {
  return spawnSync(cmd, args, { input, encoding: 'utf8', timeout: 8000 });
}

/**
 * OS-backed key storage without native modules.
 *  - Linux:   libsecret via `secret-tool`
 *  - macOS:   Keychain via `security`
 *  - Windows: DPAPI via PowerShell (blob stored in master.dpapi, only decryptable by this user)
 * Only the Linux path is exercised by this project's tests.
 */
const backends = {
  linux: {
    name: 'libsecret',
    get() {
      const r = run('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT]);
      if (r.error) return { status: 'unavailable' };
      if (r.status === 0 && r.stdout.trim()) return { status: 'found', value: r.stdout.trim() };
      if (r.status === 1 && !r.stderr.trim()) return { status: 'missing' };
      return { status: 'unavailable' };
    },
    set(b64) {
      const r = run('secret-tool', ['store', '--label=secretmgr master key', 'service', SERVICE, 'account', ACCOUNT], b64);
      return !r.error && r.status === 0;
    },
  },
  darwin: {
    name: 'macOS Keychain',
    get() {
      const r = run('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']);
      if (r.error) return { status: 'unavailable' };
      if (r.status === 0 && r.stdout.trim()) return { status: 'found', value: r.stdout.trim() };
      return { status: 'missing' };
    },
    set(b64) {
      // Note: `security -w` takes the secret as an argument, visible briefly to local `ps`.
      const r = run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', ACCOUNT, '-w', b64]);
      return !r.error && r.status === 0;
    },
  },
  win32: {
    name: 'Windows DPAPI',
    get() {
      const f = file('master.dpapi');
      if (!fs.existsSync(f)) return { status: 'missing' };
      const ps =
        "Add-Type -AssemblyName System.Security;" +
        "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());" +
        "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');" +
        "[Convert]::ToBase64String($p)";
      const r = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], fs.readFileSync(f, 'utf8'));
      if (r.error || r.status !== 0) return { status: 'unavailable' };
      return { status: 'found', value: r.stdout.trim() };
    },
    set(b64) {
      const ps =
        "Add-Type -AssemblyName System.Security;" +
        "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());" +
        "$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');" +
        "[Convert]::ToBase64String($p)";
      const r = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], b64);
      if (r.error || r.status !== 0) return false;
      fs.writeFileSync(file('master.dpapi'), r.stdout.trim() + '\n', { mode: 0o600 });
      return true;
    },
  },
};

function osBackend() {
  if (process.env.SECRETMGR_KEY_BACKEND === 'file') return null;
  return backends[process.platform] || null;
}

let cached = null;
let usedBackend = null;

export function keyBackendName() {
  return usedBackend;
}

/**
 * Returns the 32-byte master key. Pass create=true only when initialising a new vault.
 * Order: OS keychain, then ~/.secretmgr/master.key (mode 0600) as fallback.
 */
export function getMasterKey({ create = false } = {}) {
  if (cached) return cached;
  let b64 = null;

  const os = osBackend();
  if (os) {
    const r = os.get();
    if (r.status === 'found') {
      b64 = r.value;
      usedBackend = os.name;
    }
  }
  const keyFile = file('master.key');
  if (!b64 && fs.existsSync(keyFile)) {
    b64 = fs.readFileSync(keyFile, 'utf8').trim();
    usedBackend = 'file (0600)';
  }
  if (!b64) {
    if (!create) {
      throw new Error('Master key not found. If this is a new machine, run `secretmgr init`. A vault cannot be opened without its key.');
    }
    b64 = randomKey().toString('base64');
    if (os && os.set(b64)) {
      usedBackend = os.name;
    } else {
      fs.writeFileSync(keyFile, b64 + '\n', { mode: 0o600 });
      usedBackend = 'file (0600)';
    }
  }
  cached = Buffer.from(b64, 'base64');
  if (cached.length !== 32) throw new Error('Master key is corrupt (expected 32 bytes).');
  return cached;
}

export function resetKeyCache() {
  cached = null;
  usedBackend = null;
}
