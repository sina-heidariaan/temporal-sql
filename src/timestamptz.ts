/**
 * `timestamptz` ⇄ `Temporal.Instant` (default) and `Temporal.ZonedDateTime`.
 *
 * A Postgres `timestamptz` stores an absolute point in time (UTC internally) and
 * is rendered with the session's offset — it carries NO IANA zone name. So the
 * faithful decode target is `Instant`. `ZonedDateTime` is offered too, but the
 * caller must supply the IANA zone it should be projected into.
 */
import type { Temporal } from "@js-temporal/polyfill";
import { TEMPORAL_CTORS } from "temporal-gregorian/reflect";
import { guardSubMicrosecond, rejectInfinity, splitOffset, UnsupportedValueError, type EncodeOptions } from "./shared.js";

function rejectBC(text: string, t: string): void {
  if (/\bBC\b/i.test(t)) {
    throw new UnsupportedValueError(`BC timestamps are not supported by the timestamptz codec: "${text.trim()}"`);
  }
}

/** Decode a `timestamptz` text value (`2024-01-01 12:34:56.789+00`) to an `Instant`. Lossless to µs. */
export function decodeInstant(text: string): Temporal.Instant {
  rejectInfinity(text);
  const t = text.trim();
  rejectBC(text, t);
  const iso = t.replace(" ", "T");
  const [body, offset] = splitOffset(iso);
  return TEMPORAL_CTORS.Instant.from(body + offset);
}

/** Encode an `Instant` to ISO text Postgres accepts as `timestamptz` (`...Z`, µs precision). */
export function encodeInstant(value: Temporal.Instant, opts?: EncodeOptions): string {
  guardSubMicrosecond(value.epochNanoseconds % 1000n !== 0n, opts, "Instant");
  return value.toString({ smallestUnit: "microsecond" });
}

/**
 * Decode a `timestamptz` into a `ZonedDateTime` projected onto `timeZone`.
 * The offset in the text is honored for the instant; `timeZone` only chooses how
 * that instant is presented (wall-clock + zone rules).
 */
export function decodeZonedDateTime(text: string, timeZone: string): Temporal.ZonedDateTime {
  return decodeInstant(text).toZonedDateTimeISO(timeZone);
}

/** Encode a `ZonedDateTime` by reducing to its underlying instant. */
export function encodeZonedDateTime(value: Temporal.ZonedDateTime, opts?: EncodeOptions): string {
  return encodeInstant(value.toInstant(), opts);
}
