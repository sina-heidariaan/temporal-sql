/**
 * Drizzle ORM adapter — `customType` column factories for the Postgres date/time
 * family, typed to Temporal values.
 *
 * IMPORTANT: `driverData` is `string`. Drizzle's `fromDriver` only receives raw
 * text if `pg` is NOT decoding the column to a `Date` first. So when you use
 * these columns, register the passthrough parsers once at startup:
 *
 *   import { registerPassthrough } from "temporal-sql/pg";
 *   registerPassthrough();
 *
 * The global call is required here, and `makePgTypes` cannot replace it:
 * `drizzle-orm/node-postgres` attaches its own `types` to every query, which
 * overrides the pool's, and falls back to pg's **global** table for every OID it
 * does not itself pass through. That list grows between Drizzle versions, but
 * `time`, `timetz`, `time[]` and `timetz[]` are absent from every version we
 * test. `registerPassthrough()` mutates exactly that global table.
 *
 * Each factory takes optional `EncodeOptions` and returns a Drizzle column
 * builder — call it with the DB column name:
 *
 *   import * as t from "temporal-sql/drizzle";
 *   export const events = pgTable("events", {
 *     createdAt: t.timestamptz()("created_at"),
 *     window:    t.interval({ onSubMicrosecond: "truncate" })("window"),
 *   });
 */
import { customType } from "drizzle-orm/pg-core";
import type { Temporal } from "@js-temporal/polyfill";
import * as C from "./index.js";
import type { TimeWithOffset } from "./timetz.js";
import type { EncodeOptions } from "./shared.js";

/** `timestamptz` column typed as `Temporal.Instant`. */
export const timestamptz = (opts?: EncodeOptions) =>
  customType<{ data: Temporal.Instant; driverData: string }>({
    dataType: () => "timestamptz",
    toDriver: (v) => C.encodeInstant(v, opts),
    fromDriver: (v) => C.decodeInstant(v),
  });

/** `timestamp` column typed as `Temporal.PlainDateTime`. */
export const timestamp = (opts?: EncodeOptions) =>
  customType<{ data: Temporal.PlainDateTime; driverData: string }>({
    dataType: () => "timestamp",
    toDriver: (v) => C.encodePlainDateTime(v, opts),
    fromDriver: (v) => C.decodePlainDateTime(v),
  });

/** `date` column typed as `Temporal.PlainDate`. */
export const date = () =>
  customType<{ data: Temporal.PlainDate; driverData: string }>({
    dataType: () => "date",
    toDriver: (v) => C.encodePlainDate(v),
    fromDriver: (v) => C.decodePlainDate(v),
  });

/** `time` column typed as `Temporal.PlainTime`. */
export const time = (opts?: EncodeOptions) =>
  customType<{ data: Temporal.PlainTime; driverData: string }>({
    dataType: () => "time",
    toDriver: (v) => C.encodePlainTime(v, opts),
    fromDriver: (v) => C.decodePlainTime(v),
  });

/** `timetz` column typed as `{ time: PlainTime, offset }`. */
export const timetz = (opts?: EncodeOptions) =>
  customType<{ data: TimeWithOffset; driverData: string }>({
    dataType: () => "timetz",
    toDriver: (v) => C.encodeTimetz(v, opts),
    fromDriver: (v) => C.decodeTimetz(v),
  });

/** `interval` column typed as `Temporal.Duration`. */
export const interval = (opts?: EncodeOptions) =>
  customType<{ data: Temporal.Duration; driverData: string }>({
    dataType: () => "interval",
    toDriver: (v) => C.encodeDuration(v, opts),
    fromDriver: (v) => C.decodeDuration(v),
  });

/*
 * Array columns.
 *
 * These are separate factories rather than Drizzle's `.array()` modifier so the
 * element codec is this package's, not Drizzle's — one array grammar shared with
 * the `pg`, postgres.js and Prisma adapters, and identical NULL handling.
 *
 *   export const events = pgTable("events", {
 *     at: t.timestamptzArray()("at"),   // timestamptz[]
 *   });
 *
 * A Postgres array may contain SQL NULL, so the element type is `T | null`.
 * Multidimensional arrays are not supported: reading one throws
 * `UnsupportedValueError` rather than mis-mapping it.
 */

/** `timestamptz[]` column typed as `(Temporal.Instant | null)[]`. */
export const timestamptzArray = (opts?: EncodeOptions) =>
  customType<{ data: (Temporal.Instant | null)[]; driverData: string }>({
    dataType: () => "timestamptz[]",
    toDriver: (v) => C.encodePgArray(v, (x) => C.encodeInstant(x, opts)),
    fromDriver: (v) => C.decodePgArray(v, C.decodeInstant),
  });

/** `timestamp[]` column typed as `(Temporal.PlainDateTime | null)[]`. */
export const timestampArray = (opts?: EncodeOptions) =>
  customType<{ data: (Temporal.PlainDateTime | null)[]; driverData: string }>({
    dataType: () => "timestamp[]",
    toDriver: (v) => C.encodePgArray(v, (x) => C.encodePlainDateTime(x, opts)),
    fromDriver: (v) => C.decodePgArray(v, C.decodePlainDateTime),
  });

/** `date[]` column typed as `(Temporal.PlainDate | null)[]`. */
export const dateArray = () =>
  customType<{ data: (Temporal.PlainDate | null)[]; driverData: string }>({
    dataType: () => "date[]",
    toDriver: (v) => C.encodePgArray(v, (x) => C.encodePlainDate(x)),
    fromDriver: (v) => C.decodePgArray(v, C.decodePlainDate),
  });

/** `time[]` column typed as `(Temporal.PlainTime | null)[]`. */
export const timeArray = (opts?: EncodeOptions) =>
  customType<{ data: (Temporal.PlainTime | null)[]; driverData: string }>({
    dataType: () => "time[]",
    toDriver: (v) => C.encodePgArray(v, (x) => C.encodePlainTime(x, opts)),
    fromDriver: (v) => C.decodePgArray(v, C.decodePlainTime),
  });

/** `timetz[]` column typed as `({ time, offset } | null)[]`. */
export const timetzArray = (opts?: EncodeOptions) =>
  customType<{ data: (TimeWithOffset | null)[]; driverData: string }>({
    dataType: () => "timetz[]",
    toDriver: (v) => C.encodePgArray(v, (x) => C.encodeTimetz(x, opts)),
    fromDriver: (v) => C.decodePgArray(v, C.decodeTimetz),
  });

/** `interval[]` column typed as `(Temporal.Duration | null)[]`. */
export const intervalArray = (opts?: EncodeOptions) =>
  customType<{ data: (Temporal.Duration | null)[]; driverData: string }>({
    dataType: () => "interval[]",
    toDriver: (v) => C.encodePgArray(v, (x) => C.encodeDuration(x, opts)),
    fromDriver: (v) => C.decodePgArray(v, C.decodeDuration),
  });
