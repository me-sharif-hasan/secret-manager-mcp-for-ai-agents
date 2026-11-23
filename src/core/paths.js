import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Data directory. Override with SECRETMGR_HOME (used by tests). */
export function dataDir() {
  const dir = process.env.SECRETMGR_HOME || path.join(os.homedir(), '.secretmgr');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function file(name) {
  return path.join(dataDir(), name);
}

/**
 * The version file is the fast path for shell prompt hooks: they read one line
 * with shell built-ins and only call secretmgr when it changed.
 */
export function bumpVersion() {
  const v = `${Date.now()}.${Math.random().toString(36).slice(2, 7)}`;
  const f = file('version');
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, v + '\n', { mode: 0o600 });
  fs.renameSync(tmp, f);
  return v;
}

export function readVersion() {
  try {
    return fs.readFileSync(file('version'), 'utf8').trim();
  } catch {
    return '0';
  }
}
