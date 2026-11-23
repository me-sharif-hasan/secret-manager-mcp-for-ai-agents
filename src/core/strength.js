// Pure JavaScript with no Node imports: the dashboard bundles this same file, so server and UI always agree.
const COMMON = ['password', 'passw0rd', 'qwerty', 'letmein', 'welcome', 'admin', 'secret', 'iloveyou', 'monkey', 'dragon', 'abc123', '123456', 'secretmgr'];

/**
 * A rough estimate, not a guarantee. It cannot know that "mydogiscalledbuster" is a sentence.
 * The dashboard offers a random generator because that is the only reliably strong choice.
 */
export function checkStrength(pw) {
  const s = String(pw ?? '');
  if (s.length < 12) return { ok: false, bits: 0, reason: 'Use at least 12 characters' };
  let pool = 0;
  if (/[a-z]/.test(s)) pool += 26;
  if (/[A-Z]/.test(s)) pool += 26;
  if (/[0-9]/.test(s)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(s)) pool += 33;
  const unique = new Set(s).size;
  const effective = Math.min(s.length, unique * 2);
  let bits = effective * Math.log2(pool);
  const lower = s.toLowerCase();
  for (const w of COMMON) if (lower.includes(w)) bits -= 25;
  if (/(.)\1{3,}/.test(s)) bits -= 15;
  if (/(?:0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef)/i.test(s)) bits -= 15;
  bits = Math.max(0, Math.round(bits));
  if (bits < 60) return { ok: false, bits, reason: 'Too easy to guess. Use a longer password or the generator' };
  return { ok: true, bits, reason: '' };
}
