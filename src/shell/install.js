import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { file } from '../core/paths.js';
import { initScript, cmdFiles } from './init.js';

const START = '# >>> secretmgr >>>';
const END = '# <<< secretmgr <<<';
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cli/index.js');

const home = () => process.env.HOME || os.homedir();

/** How the shell scripts should call us: plain `secretmgr` if it is on PATH, else this checkout. */
export function binCommand() {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['secretmgr'], { encoding: 'utf8' });
  return probe.status === 0 ? null : `${process.execPath} ${CLI}`;
}

function backupOnce(target) {
  if (fs.existsSync(target) && !fs.existsSync(`${target}.secretmgr.bak`)) fs.copyFileSync(target, `${target}.secretmgr.bak`);
}

export function stripBlock(text) {
  const re = new RegExp(`\\n?${START}[\\s\\S]*?${END}\\n?`, 'g');
  return text.replace(re, '\n');
}

function writeBlock(target, body) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  backupOnce(target);
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  const next = stripBlock(existing).replace(/\n*$/, '\n') + `\n${START}\n${body}\n${END}\n`;
  fs.writeFileSync(target, next);
}

function removeBlock(target) {
  if (!fs.existsSync(target)) return false;
  const text = fs.readFileSync(target, 'utf8');
  if (!text.includes(START)) return false;
  fs.writeFileSync(target, stripBlock(text).replace(/\n{3,}/g, '\n\n'));
  return true;
}

function shellTargets() {
  const h = home();
  const targets = [
    { shell: 'bash', rc: path.join(h, '.bashrc') },
    { shell: 'zsh', rc: path.join(process.env.ZDOTDIR || h, '.zshrc') },
    { shell: 'fish', rc: path.join(process.env.XDG_CONFIG_HOME || path.join(h, '.config'), 'fish', 'config.fish') },
  ];
  const pw = path.join(process.env.XDG_CONFIG_HOME || path.join(h, '.config'), 'powershell', 'Microsoft.PowerShell_profile.ps1');
  targets.push({ shell: 'pwsh', rc: process.platform === 'win32' ? path.join(h, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1') : pw });
  return targets;
}

/** Write static init scripts and add one sourcing line per shell. Only touches shells that look installed. */
export function installShells({ shells } = {}) {
  const bin = binCommand();
  const dir = path.join(file('init'));
  fs.mkdirSync(dir, { recursive: true });
  const report = [];
  for (const { shell, rc } of shellTargets()) {
    if (shells && !shells.includes(shell)) continue;
    // Touch a shell's startup file only if the user asked for it, it already exists, or it is their login shell.
    const login = path.basename(process.env.SHELL || '');
    const present = shells?.includes(shell) || fs.existsSync(rc) || login === shell || (shell === 'pwsh' && login === 'pwsh') || (shell === 'bash' && !process.env.SHELL);
    if (!present) continue;
    const script = path.join(dir, shell === 'pwsh' ? 'init.ps1' : `init.${shell}`);
    fs.writeFileSync(script, initScript(shell), { mode: 0o600 });
    const binLine = bin ? (shell === 'fish' ? `set -gx SECRETMGR_BIN "${bin}"` : shell === 'pwsh' ? `$env:SECRETMGR_BIN = '${bin}'` : `export SECRETMGR_BIN='${bin}'`) : '';
    const source = shell === 'fish' ? `test -r "${script}"; and source "${script}"` : shell === 'pwsh' ? `if (Test-Path '${script}') { . '${script}' }` : `[ -r "${script}" ] && . "${script}"`;
    writeBlock(rc, [binLine, source].filter(Boolean).join('\n'));
    report.push({ shell, file: rc });
  }
  if (process.platform === 'win32') {
    const files = cmdFiles(bin);
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(file(name), body.replace(/\n/g, '\r\n'));
    const r = spawnSync('reg', ['add', 'HKCU\\Software\\Microsoft\\Command Processor', '/v', 'AutoRun', '/t', 'REG_SZ', '/d', `"${file('autorun.cmd')}"`, '/f'], { encoding: 'utf8' });
    report.push({ shell: 'cmd', file: r.status === 0 ? 'registry AutoRun' : `failed: ${r.stderr || r.error}` });
  }
  return report;
}

export function uninstallShells() {
  const removed = [];
  for (const { shell, rc } of shellTargets()) if (removeBlock(rc)) removed.push({ shell, file: rc });
  if (process.platform === 'win32') {
    const r = spawnSync('reg', ['delete', 'HKCU\\Software\\Microsoft\\Command Processor', '/v', 'AutoRun', '/f'], { encoding: 'utf8' });
    if (r.status === 0) removed.push({ shell: 'cmd', file: 'registry AutoRun' });
  }
  return removed;
}

// ------------------------------------------------------------ Claude Code

const claudeSettings = () => path.join(home(), '.claude', 'settings.json');
const HOOK_CMD = () => `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} hook pretooluse`;
const isOurs = (h) => typeof h?.command === 'string' && h.command.includes('hook pretooluse');

export function installClaude() {
  const f = claudeSettings();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  backupOnce(f);
  const cfg = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8') || '{}') : {};
  cfg.hooks ??= {};
  cfg.hooks.PreToolUse ??= [];
  for (const entry of cfg.hooks.PreToolUse) entry.hooks = (entry.hooks || []).filter((h) => !isOurs(h));
  cfg.hooks.PreToolUse = cfg.hooks.PreToolUse.filter((e) => e.hooks.length);
  cfg.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: HOOK_CMD() }] });
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n');

  const mcpArgs = ['mcp', 'add', '--scope', 'user', 'secretmgr', '--', process.execPath, CLI, 'mcp'];
  const claude = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' });
  let mcp;
  if (claude.status === 0) {
    const r = spawnSync('claude', mcpArgs, { encoding: 'utf8' });
    mcp = r.status === 0 ? 'registered' : `failed (${(r.stderr || r.stdout || '').trim().split('\n')[0]})`;
  } else {
    mcp = `claude CLI not found. Run: claude ${mcpArgs.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;
  }
  return { settings: f, mcp };
}

export function uninstallClaude() {
  const f = claudeSettings();
  if (!fs.existsSync(f)) return false;
  const cfg = JSON.parse(fs.readFileSync(f, 'utf8') || '{}');
  let changed = false;
  for (const entry of cfg.hooks?.PreToolUse || []) {
    const before = entry.hooks.length;
    entry.hooks = entry.hooks.filter((h) => !isOurs(h));
    changed ||= entry.hooks.length !== before;
  }
  if (cfg.hooks?.PreToolUse) cfg.hooks.PreToolUse = cfg.hooks.PreToolUse.filter((e) => e.hooks.length);
  if (changed) fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n');
  return changed;
}
