// Pure JavaScript with no Node imports: the dashboard bundles this same file, so server and UI always agree.
const COMMON = ['password', 'passw0rd', 'qwerty', 'letmein', 'welcome', 'admin', 'secret', 'iloveyou', 'monkey', 'dragon', 'abc123', '123456', 'secretmgr'];

/**
 * The rule: at least 8 characters with a capital, a small letter, a number and a special character, and
 * nothing obviously common. `bits` is a rough estimate of how hard it is to guess, shown to the owner;
 * it cannot know that "MyD0g!sBuster" is a phrase. Short passwords meet the rule but are guessable
 * offline by someone holding the vault files, which is why the dashboard also offers a random generator.
 */
export function checkStrength(pw) {
  const s = String(pw ?? '');
  const has = { lower: /[a-z]/.test(s), upper: /[A-Z]/.test(s), digit: /[0-9]/.test(s), special: /[^a-zA-Z0-9]/.test(s) };

  let pool = 0;
  if (has.lower) pool += 26;
  if (has.upper) pool += 26;
  if (has.digit) pool += 10;
  if (has.special) pool += 33;
  const unique = new Set(s).size;
  let bits = pool ? Math.min(s.length, unique * 2) * Math.log2(pool) : 0;
  const lower = s.toLowerCase();
  for (const w of COMMON) if (lower.includes(w)) bits -= 25;
  if (/(.)\1{3,}/.test(s)) bits -= 15;
  if (/(?:0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef)/i.test(s)) bits -= 15;
  bits = Math.max(0, Math.round(bits));

  const missing = [];
  if (s.length < 8) missing.push('at least 8 characters');
  if (!has.upper) missing.push('a capital letter');
  if (!has.lower) missing.push('a small letter');
  if (!has.digit) missing.push('a number');
  if (!has.special) missing.push('a special character');
  if (missing.length) return { ok: false, bits, reason: `Needs ${missing.join(', ')}` };
  if (COMMON.some((w) => lower.includes(w))) return { ok: false, bits, reason: 'Too common. Pick something less obvious' };
  return { ok: true, bits, reason: '' };
}
