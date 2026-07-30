/**
 * temporal-sql — pure codec core.
 *
 * Driver-agnostic functions that convert between Postgres date/time text and
 * TC39 Temporal values. Import a driver adapter (`temporal-sql/pg`,
 * `/postgres-js`, `/drizzle`, `/prisma`) to wire these into your stack, or use
 * these directly. No JS `Date` appears anywhere in this package.
 */
export {
  type EncodeOptions,
  type SubMicrosecondMode,
  PrecisionError,
  MixedSignIntervalError,
  UnsupportedValueError,
  normalizeOffset,
} from "./shared.js";

export { OID, type Oid } from "./oids.js";

// Postgres array literal ⇄ JS array, shared by every adapter
export {
  parsePgArray,
  formatPgArray,
  decodePgArray,
  encodePgArray,
  type PgArrayElement,
} from "./array.js";

// interval ⇄ Duration (headline)
export { decodeDuration, encodeDuration } from "./interval.js";

// timestamptz ⇄ Instant / ZonedDateTime
export {
  decodeInstant,
  encodeInstant,
  decodeZonedDateTime,
  encodeZonedDateTime,
  decodeZonedDateTimeArray,
  encodeZonedDateTimeArray,
} from "./timestamptz.js";

// timestamp ⇄ PlainDateTime
export { decodePlainDateTime, encodePlainDateTime } from "./timestamp.js";

// date ⇄ PlainDate
export { decodePlainDate, encodePlainDate } from "./date.js";

// time ⇄ PlainTime
export { decodePlainTime, encodePlainTime } from "./time.js";

// timetz ⇄ { time, offset }
export { decodeTimetz, decodeTimetzTime, encodeTimetz, type TimeWithOffset } from "./timetz.js";
