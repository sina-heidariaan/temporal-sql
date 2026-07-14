/**
 * `date` ⇄ `Temporal.PlainDate`.
 *
 * Handles the two Postgres quirks: BC years (proleptic `year = 1 - bcYear`, so
 * `44 BC` ↔ proleptic `-43`) and years ≥ 10000 which print without zero-padding.
 */
import type { Temporal } from "@js-temporal/polyfill";
import { TEMPORAL_CTORS } from "temporal-gregorian/reflect";
import { rejectInfinity, UnsupportedValueError } from "./shared.js";

const pad2 = (n: number): string => String(n).padStart(2, "0");
const pad4 = (n: number): string => String(n).padStart(4, "0");

/** Decode a `date` text value (`2024-01-01`, `0044-03-15 BC`) to a `PlainDate`. */
export function decodePlainDate(text: string): Temporal.PlainDate {
  rejectInfinity(text);
  let t = text.trim();
  let bc = false;
  if (/\bBC\b/i.test(t)) {
    bc = true;
    t = t.replace(/\s*BC\s*$/i, "").trim();
  }
  const m = /^(\d+)-(\d{2})-(\d{2})$/.exec(t);
  if (!m) throw new UnsupportedValueError(`Unparseable date: "${text.trim()}"`);
  let year = parseInt(m[1] as string, 10);
  if (bc) year = 1 - year; // 44 BC -> -43 (proleptic Gregorian; year 0 = 1 BC)
  return TEMPORAL_CTORS.PlainDate.from({ year, month: parseInt(m[2] as string, 10), day: parseInt(m[3] as string, 10) });
}

/** Encode a `PlainDate` to text Postgres accepts as `date` (emits ` BC` for year ≤ 0). */
export function encodePlainDate(value: Temporal.PlainDate): string {
  const { year, month, day } = value;
  if (year <= 0) {
    return `${pad4(1 - year)}-${pad2(month)}-${pad2(day)} BC`;
  }
  return `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
}
