// Certificate reference numbers: ASI-<YYYY>-<TYPE>-<NNNNNN>-<C>. OWNER: WS-CERTIFICATES.
// Mirrors backend/apps/engagement/certificates.py (parse_reference): the check
// character is Luhn mod 36 over "ASI", the year, the type and the sequence, so
// a single mistyped character is caught here before any request is sent.

export const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const TYPES = ["OSINT", "PEN", "COURSE", "EXAM", "CTF", "BADGE", "LEVEL"];
export const REFERENCE_EXAMPLE = "ASI-2026-OSINT-000123-X";

const BASE = ALPHABET.length;
const LOOKALIKE_DIGITS = { O: "0", Q: "0", D: "0", I: "1", L: "1", Z: "2", S: "5", B: "8" };
const PATTERN = /^ASI-?([0-9OQDILZSB]{4})-?([A-Z]{2,8})-?([0-9OQDILZSB]{6,12})-?([0-9A-Z])$/;

const toDigits = (text) => text.replace(/[OQDILZSB]/g, (char) => LOOKALIKE_DIGITS[char]);

function luhnTotal(chars, startFactor) {
  let factor = startFactor;
  let total = 0;
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const value = ALPHABET.indexOf(chars[index]);
    if (value < 0) continue;
    const addend = factor * value;
    factor = factor === 2 ? 1 : 2;
    total += Math.floor(addend / BASE) + (addend % BASE);
  }
  return total;
}

/** The check character for a reference body such as "ASI-2026-OSINT-000123". */
export function checkCharacter(body) {
  const total = luhnTotal(String(body).toUpperCase(), 2);
  return ALPHABET[(BASE - (total % BASE)) % BASE];
}

/** True when the reference likely starts like one of ours (so a slug is not mistaken for a typo). */
export function looksLikeReference(text) {
  return String(text || "").trim().toUpperCase().startsWith("ASI");
}

/**
 * Normalises what a person typed. Returns `{ ok: true, reference }` (canonical
 * spelling) or `{ ok: false, reason }` with reason "empty" | "format" | "check".
 */
export function parseReference(text) {
  let raw = String(text || "").normalize("NFKC").toUpperCase().trim();
  if (!raw) return { ok: false, reason: "empty" };
  raw = raw.replace(/[\s_.‐-―]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  const match = raw.length <= 40 ? PATTERN.exec(raw) : null;
  if (!match) return { ok: false, reason: "format" };
  const [, yearRaw, type, sequenceRaw, check] = match;
  const sequence = Number.parseInt(toDigits(sequenceRaw), 10);
  if (!TYPES.includes(type) || !(sequence >= 1)) return { ok: false, reason: "format" };
  const body = `ASI-${toDigits(yearRaw)}-${type}-${String(sequence).padStart(6, "0")}`;
  if (luhnTotal(body + check, 1) % BASE !== 0) return { ok: false, reason: "check" };
  return { ok: true, reference: `${body}-${check}` };
}

/** Builds a reference (tests and examples). */
export function formatReference(year, type, sequence) {
  const body = `ASI-${year}-${type}-${String(sequence).padStart(6, "0")}`;
  return `${body}-${checkCharacter(body)}`;
}

export const REFERENCE_PROBLEMS = {
  empty: "Enter the reference number printed on the certificate.",
  format: `That is not a reference number. It looks like ${REFERENCE_EXAMPLE}.`,
  check: "This reference number has a typo: its last character does not match. Check each character and try again.",
};
