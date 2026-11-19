// Phone numbers for owner texts. The firewall stores E.164 only (+ then 7-15 digits, no leading 0),
// so the dashboard accepts the ways people actually type a number and normalizes before saving.
const E164 = /^\+[1-9]\d{6,14}$/;

/** "+1 (604) 555-0100" → "+16045550100". Returns null when it can't be read as an international number. */
export function normalizePhone(raw: string): string | null {
  let s = raw.trim().replace(/[\s().\- ]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  return E164.test(s) ? s : null;
}

/** Display an E.164 number with light grouping for North American numbers; others are shown as stored. */
export function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `+1 ${m[1]} ${m[2]} ${m[3]}` : e164;
}
