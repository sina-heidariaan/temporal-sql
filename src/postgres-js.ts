/**
 * postgres.js adapter — custom type handlers for its `types` option.
 *
 * Each entry is `{ to, from, serialize, parse }`: `to` is the OID used when
 * sending, `from` the OID(s) parsed on receipt, and `serialize`/`parse` the
 * codec functions. Usage:
 *
 *   import postgres from "postgres";
 *   import { temporalTypes } from "temporal-sql/postgres-js";
 *   const sql = postgres(url, { types: temporalTypes });
 *   await sql`insert into t (at) values (${ sql.typed.instant(myInstant) })`;
 *
 * Each type has an `*Array` sibling for the matching Postgres array type, e.g.
 * `sql.typed.instantArray([a, b])` for `timestamptz[]`. Array elements may be
 * `null`, so an array decodes to `(T | null)[]`.
 */
import type { Temporal } from "@js-temporal/polyfill";
import { OID } from "./oids.js";
import * as C from "./index.js";
import type { TimeWithOffset } from "./timetz.js";
import type { EncodeOptions } from "./shared.js";

interface PostgresType<T> {
  to: number;
  from: number[];
  serialize: (value: T) => string;
  parse: (raw: string) => unknown;
}

/**
 * Build the postgres.js type map. Pass `EncodeOptions` (e.g.
 * `{ onSubMicrosecond: "truncate" }`) to control precision behavior on write.
 */
export function makeTemporalTypes(opts?: EncodeOptions) {
  const instant: PostgresType<Temporal.Instant> = {
    to: OID.timestamptz,
    from: [OID.timestamptz],
    serialize: (v) => C.encodeInstant(v, opts),
    parse: C.decodeInstant,
  };
  const plainDateTime: PostgresType<Temporal.PlainDateTime> = {
    to: OID.timestamp,
    from: [OID.timestamp],
    serialize: (v) => C.encodePlainDateTime(v, opts),
    parse: C.decodePlainDateTime,
  };
  const plainDate: PostgresType<Temporal.PlainDate> = {
    to: OID.date,
    from: [OID.date],
    serialize: (v) => C.encodePlainDate(v),
    parse: C.decodePlainDate,
  };
  const plainTime: PostgresType<Temporal.PlainTime> = {
    to: OID.time,
    from: [OID.time],
    serialize: (v) => C.encodePlainTime(v, opts),
    parse: C.decodePlainTime,
  };
  const timetz: PostgresType<TimeWithOffset> = {
    to: OID.timetz,
    from: [OID.timetz],
    serialize: (v) => C.encodeTimetz(v, opts),
    parse: C.decodeTimetz,
  };
  const duration: PostgresType<Temporal.Duration> = {
    to: OID.interval,
    from: [OID.interval],
    serialize: (v) => C.encodeDuration(v, opts),
    parse: C.decodeDuration,
  };

  // Array variants. postgres.js can derive an array parser for a registered
  // scalar type by querying pg_catalog, but only for array OIDs that have no
  // handler yet — registering these explicitly keeps the behaviour deterministic
  // and independent of the `fetch_types` round trip.
  const array = <T>(
    scalar: PostgresType<T>,
    arrayOid: number,
  ): PostgresType<readonly (T | null)[]> => ({
    to: arrayOid,
    from: [arrayOid],
    serialize: (v) => C.encodePgArray(v, scalar.serialize),
    parse: (raw) => C.decodePgArray(raw, scalar.parse),
  });

  return {
    instant,
    plainDateTime,
    plainDate,
    plainTime,
    timetz,
    duration,
    instantArray: array(instant, OID.timestamptzArray),
    plainDateTimeArray: array(plainDateTime, OID.timestampArray),
    plainDateArray: array(plainDate, OID.dateArray),
    plainTimeArray: array(plainTime, OID.timeArray),
    timetzArray: array(timetz, OID.timetzArray),
    durationArray: array(duration, OID.intervalArray),
  };
}

/** Default type map (precision `throw` mode). Use {@link makeTemporalTypes} to configure. */
export const temporalTypes = makeTemporalTypes();
