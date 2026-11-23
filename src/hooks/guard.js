/**
 * Heuristic checks on an agent Bash command, run before the command is wrapped.
 * This is a seatbelt, not a sandbox: output redaction is the second layer, and the
 * agent runs as the same OS user, so a determined adversary is out of scope.
 */

const CMDPOS = String.raw`(?:^|[;&|(\n\`]|\$\()\s*`;
const END = String.raw`\s*(?:$|[;&|)\n>\`])`;

const DUMPERS = [
  [new RegExp(CMDPOS + String.raw`(?:env|set|export|export\s+-p|declare\s+-[a-zA-Z]*[xp]|typeset\s+-[a-zA-Z]*x|compgen\s+-e)` + END, 'm'), 'dumps the whole environment'],
  [new RegExp(CMDPOS + String.raw`printenv\b`, 'm'), 'prints environment variables'],
  [/\/proc\/[^\s/]+\/environ/, 'reads process environments'],
];

const SELF = [
  [/\.secretmgr\b|SECRETMGR_[A-Z_]+/, 'touches the secretmgr data directory or settings'],
  [/(?:secretmgr|cli\/index\.js)(?:\.js)?["']?\s+(?:env|reveal|export|shell|dashboard|install|uninstall|exec-env|redact|hook|mcp|unlock|protect|passwd|agent)\b/, 'calls a secretmgr command that can expose values'],
  [/(?:secretmgr|cli\/index\.js)(?:\.js)?["']?\s+kill\b.*(?:--off|restore)/, 'tries to turn the kill switch off'],
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** managedNames: iterable of variable names the vault controls. Returns a reason string, or null if allowed. */
export function analyzeCommand(command, managedNames = []) {
  for (const [re, why] of [...DUMPERS, ...SELF]) if (re.test(command)) return `this command ${why}`;
  const names = [...managedNames];
  if (names.length) {
    const alt = names.map(esc).join('|');
    const printers = String.raw`(?:echo|printf|print|cat|tee|awk|python3?\s+-c|node\s+-e|ruby\s+-e|perl\s+-e)\b`;
    const re = new RegExp(`${printers}[^\\n;&|]*\\$\\{?(?:${alt})\\b`);
    if (re.test(command)) return 'this command would print a secret variable. Use it inside another command instead, for example PGPASSWORD="$PG_PASS" psql …';
    if (new RegExp(`\\$\\{!`).test(command) || new RegExp(`(?:declare|typeset)\\s+-p\\s+(?:${alt})\\b`).test(command)) return 'this command inspects secret variables indirectly';
  }
  return null;
}

/**
 * Wrap the original command so that, in an isolated subshell, inherited secrets are stripped,
 * the active environments are loaded, and all output passes through the redactor.
 * The original command text stays fully visible inside the wrapper so permission prompts remain readable.
 * Working directory changes are carried back to the calling shell.
 */
export function wrapCommand(original, nodePath, cliPath, { locked = false } = {}) {
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  const N = q(nodePath);
  const C = q(cliPath);
  // Locked vault: nothing is loaded, so exec-env only strips and redact passes output through. Both are told
  // explicitly, so an unlock that happens mid-command can never leave secrets loaded with redaction off.
  const flag = locked ? ' --locked' : '';
  return [
    `__smd="$(mktemp)" && (`,
    `__smenv="$(${N} ${C} exec-env${flag})" || { echo 'secretmgr: could not prepare the environment, command not run' >&2; exit 126; }`,
    `eval "$__smenv"; unset __smenv`,
    `trap 'echo $? > "$__smd.rc"; pwd -P > "$__smd"' EXIT`,
    original,
    `) 2>&1 | ${N} ${C} redact${flag}; __smrc="$(cat "$__smd.rc" 2>/dev/null)"; [ -s "$__smd" ] && cd "$(cat "$__smd")" 2>/dev/null; rm -f "$__smd" "$__smd.rc"; (exit "\${__smrc:-1}")`,
  ].join('\n');
}
