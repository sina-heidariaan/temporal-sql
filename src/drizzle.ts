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
