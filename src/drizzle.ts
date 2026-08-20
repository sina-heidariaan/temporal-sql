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
 * Every factory can be called two ways:
 *
 *   // one call — column name (and optional EncodeOptions) in one step
 *   import * as t from "temporal-sql/drizzle";
 *   export const events = pgTable("events", {
 *     createdAt: t.timestamptz("created_at"),
 *     window:    t.interval("window", { onSubMicrosecond: "truncate" }),
 *   });
 *
 *   // two calls — options first, name second (the pre-0.4 form; still supported)
 *   createdAt: t.timestamptz()("created_at"),
 *   window:    t.interval({ onSubMicrosecond: "truncate" })("window"),
 */
import { customType, type PgCustomColumnBuilder, type ConvertCustomConfig } from "drizzle-orm/pg-core";
import type { Temporal } from "@js-temporal/polyfill";
import * as C from "./index.js";
import type { TimeWithOffset } from "./timetz.js";
import type { EncodeOptions } from "./shared.js";

/** The customType config every column here uses: Temporal in, raw text at the driver. */
type Cfg<T> = { data: T; driverData: string };

/** A named column builder, exactly as `customType(...)("name")` would type it. */
type NamedColumn<TName extends string, T> = PgCustomColumnBuilder<ConvertCustomConfig<TName, Cfg<T>>>;

/** What the two-call form returns after the first call: drizzle's own builder function. */
type ColumnBuilderFn<T> = {
  (): NamedColumn<"", T>;
  <TName extends string>(dbName: TName): NamedColumn<TName, T>;
};

/**
 * A column factory supporting both call shapes:
 * `factory("db_name", opts?)` and `factory(opts?)("db_name")`.
 */
export type TemporalColumn<T> = {
  <TName extends string>(name: TName, opts?: EncodeOptions): NamedColumn<TName, T>;
  (opts?: EncodeOptions): ColumnBuilderFn<T>;
};

function makeColumn<T>(
  dataType: string,
  toDriver: (value: T, opts?: EncodeOptions) => string,
  fromDriver: (value: string) => T,
): TemporalColumn<T> {
  const build = (opts?: EncodeOptions) =>
    customType<Cfg<T>>({
      dataType: () => dataType,
      toDriver: (v) => toDriver(v, opts),
      fromDriver,
    });
  return ((nameOrOpts?: string | EncodeOptions, opts?: EncodeOptions) =>
    typeof nameOrOpts === "string" ? build(opts)(nameOrOpts) : build(nameOrOpts)) as TemporalColumn<T>;
}

/** `timestamptz` column typed as `Temporal.Instant`. */
export const timestamptz = makeColumn<Temporal.Instant>(
  "timestamptz",
  (v, o) => C.encodeInstant(v, o),
  C.decodeInstant,
);

/** `timestamp` column typed as `Temporal.PlainDateTime`. */
export const timestamp = makeColumn<Temporal.PlainDateTime>(
  "timestamp",
  (v, o) => C.encodePlainDateTime(v, o),
  C.decodePlainDateTime,
);

/** `date` column typed as `Temporal.PlainDate`. */
export const date = makeColumn<Temporal.PlainDate>("date", (v) => C.encodePlainDate(v), C.decodePlainDate);

/** `time` column typed as `Temporal.PlainTime`. */
export const time = makeColumn<Temporal.PlainTime>("time", (v, o) => C.encodePlainTime(v, o), C.decodePlainTime);

/** `timetz` column typed as `{ time: PlainTime, offset }`. */
export const timetz = makeColumn<TimeWithOffset>("timetz", (v, o) => C.encodeTimetz(v, o), C.decodeTimetz);

/** `interval` column typed as `Temporal.Duration`. */
export const interval = makeColumn<Temporal.Duration>(
  "interval",
  (v, o) => C.encodeDuration(v, o),
  C.decodeDuration,
);

/*
 * Array columns.
 *
 * These are separate factories rather than Drizzle's `.array()` modifier so the
 * element codec is this package's, not Drizzle's — one array grammar shared with
 * the `pg`, postgres.js and Prisma adapters, and identical NULL handling.
 *
 *   export const events = pgTable("events", {
 *     at: t.timestamptzArray("at"),   // timestamptz[]
 *   });
 *
 * A Postgres array may contain SQL NULL, so the element type is `T | null`.
 * Multidimensional arrays are not supported: reading one throws
 * `UnsupportedValueError` rather than mis-mapping it.
 */

/** `timestamptz[]` column typed as `(Temporal.Instant | null)[]`. */
export const timestamptzArray = makeColumn<(Temporal.Instant | null)[]>(
  "timestamptz[]",
  (v, o) => C.encodePgArray(v, (x) => C.encodeInstant(x, o)),
  (v) => C.decodePgArray(v, C.decodeInstant),
);

/** `timestamp[]` column typed as `(Temporal.PlainDateTime | null)[]`. */
export const timestampArray = makeColumn<(Temporal.PlainDateTime | null)[]>(
  "timestamp[]",
  (v, o) => C.encodePgArray(v, (x) => C.encodePlainDateTime(x, o)),
  (v) => C.decodePgArray(v, C.decodePlainDateTime),
);

/** `date[]` column typed as `(Temporal.PlainDate | null)[]`. */
export const dateArray = makeColumn<(Temporal.PlainDate | null)[]>(
  "date[]",
  (v) => C.encodePgArray(v, (x) => C.encodePlainDate(x)),
  (v) => C.decodePgArray(v, C.decodePlainDate),
);

/** `time[]` column typed as `(Temporal.PlainTime | null)[]`. */
export const timeArray = makeColumn<(Temporal.PlainTime | null)[]>(
  "time[]",
  (v, o) => C.encodePgArray(v, (x) => C.encodePlainTime(x, o)),
  (v) => C.decodePgArray(v, C.decodePlainTime),
);

/** `timetz[]` column typed as `({ time, offset } | null)[]`. */
export const timetzArray = makeColumn<(TimeWithOffset | null)[]>(
  "timetz[]",
  (v, o) => C.encodePgArray(v, (x) => C.encodeTimetz(x, o)),
  (v) => C.decodePgArray(v, C.decodeTimetz),
);

/** `interval[]` column typed as `(Temporal.Duration | null)[]`. */
export const intervalArray = makeColumn<(Temporal.Duration | null)[]>(
  "interval[]",
  (v, o) => C.encodePgArray(v, (x) => C.encodeDuration(x, o)),
  (v) => C.decodePgArray(v, C.decodeDuration),
);
