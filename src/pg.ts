/**
 * node-postgres (`pg`) adapter.
 *
 * Decode is registered through pg-types' `setTypeParser` keyed by OID. Encode is
 * asymmetric: `pg` has no per-type serializer registry, so pass a Temporal value
 * through the matching `encode.*` helper and hand the returned string to your
 * query as a parameter (Postgres casts the text to the column type).
 *
 * IMPORTANT for the Drizzle adapter: Drizzle's custom columns expect raw text in
 * `fromDriver`. If you use `temporal-sql/drizzle`, call {@link registerPassthrough}
 * (not {@link registerTypeParsers}) so pg hands Drizzle the raw string instead of
 * decoding to a JS `Date` first.
 *
 * Both `register*` functions mutate pg's process-wide parser table. To confine
 * the change to one pool instead, use {@link makePgTypes}.
 */
// Default import, not `import { types } from "pg"`. `pg` is CommonJS, so a named
// import only resolves when Node's cjs-module-lexer can statically detect the
// export — which it cannot before pg 8.15.0, making ESM consumers on older pg
// fail at module load with "does not provide an export named 'types'". The
// default import reads `module.exports` and works on every pg 8.x.
import pg from "pg";
import type { Temporal } from "@js-temporal/polyfill";
import { OID } from "./oids.js";
import * as C from "./index.js";
import type { TimeWithOffset } from "./timetz.js";
import type { EncodeOptions } from "./shared.js";

const pgTypes = pg.types;

type SetTypeParser = (oid: number, parseFn: (value: string) => unknown) => void;

export interface RegisterOptions {
  /**
   * Override the parser registry (e.g. a specific pool's `types.setTypeParser`).
   * Defaults to the global `pg.types.setTypeParser`.
   */
  setTypeParser?: SetTypeParser;
}

const decoders: Array<[number, (value: string) => unknown]> = [
  [OID.timestamptz, C.decodeInstant],
  [OID.timestamp, C.decodePlainDateTime],
  [OID.date, C.decodePlainDate],
  [OID.time, C.decodePlainTime],
  [OID.timetz, C.decodeTimetz],
  [OID.interval, C.decodeDuration],
  // Array OIDs decode through the same scalar codecs, one element at a time.
  // A SQL NULL element stays `null`, so these yield `(T | null)[]`.
  [OID.timestamptzArray, (v) => C.decodePgArray(v, C.decodeInstant)],
  [OID.timestampArray, (v) => C.decodePgArray(v, C.decodePlainDateTime)],
  [OID.dateArray, (v) => C.decodePgArray(v, C.decodePlainDate)],
  [OID.timeArray, (v) => C.decodePgArray(v, C.decodePlainTime)],
  [OID.timetzArray, (v) => C.decodePgArray(v, C.decodeTimetz)],
  [OID.intervalArray, (v) => C.decodePgArray(v, C.decodeDuration)],
];

/**
 * Undo a registration, putting back the parser each OID had beforehand.
 * Calling it more than once is harmless.
 */
export type RestoreTypeParsers = () => void;

/** Shared body: set `parserFor(oid)` on every OID we own, and return the undo. */
function register(opts: RegisterOptions, parserFor: (oid: number) => (value: string) => unknown): RestoreTypeParsers {
  const set = opts.setTypeParser ?? (pgTypes.setTypeParser as unknown as SetTypeParser);
  // Snapshot before overwriting. Read from pg's table even when a custom setter
  // is supplied: that setter's target starts out delegating to pg's defaults, so
  // these are the right values to put back.
  const previous = decoders.map(([oid]) => [oid, pgTypes.getTypeParser(oid as never)] as const);
  for (const [oid] of decoders) set(oid, parserFor(oid));

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const [oid, fn] of previous) set(oid, fn as (value: string) => unknown);
  };
}

/**
 * Register Temporal decoders for the date/time OIDs, so `SELECT`ed values come
 * back as Temporal objects. `timestamptz` decodes to `Instant` (a `ZonedDateTime`
 * needs a caller-chosen zone, so it can't be auto-registered — use
 * `decodeZonedDateTime` manually).
 *
 * @returns a function that puts pg's previous parsers back. Ignore it for the
 *   usual call-once-at-startup case; use it in tests, or in a library that must
 *   leave the process as it found it.
 */
export function registerTypeParsers(opts: RegisterOptions = {}): RestoreTypeParsers {
  const byOid = new Map(decoders);
  return register(opts, (oid) => byOid.get(oid)!);
}

/**
 * Register identity (raw-text) parsers for the date/time OIDs. Required when the
 * Drizzle adapter is in use so `fromDriver` receives the original string instead
 * of a pg-decoded `Date`.
 *
 * @returns the same undo function {@link registerTypeParsers} returns.
 */
export function registerPassthrough(opts: RegisterOptions = {}): RestoreTypeParsers {
  const identity = (value: string): string => value;
  return register(opts, () => identity);
}

/** How {@link makePgTypes} should treat the date/time OIDs it owns. */
export type PgTypesMode = "temporal" | "passthrough";

export interface MakePgTypesOptions {
  /**
   * `"temporal"` (default) decodes to Temporal values, like
   * {@link registerTypeParsers}. `"passthrough"` returns raw text, like
   * {@link registerPassthrough} — the mode the Drizzle columns need.
   */
  mode?: PgTypesMode;
}

/** The shape `pg` accepts as `new Pool({ types })`. */
export interface PgTypeOverrides {
  getTypeParser: (oid: number, format?: string) => (value: string) => unknown;
}

/**
 * Build a per-pool parser table instead of mutating pg's global one.
 *
 *   import pg from "pg";
 *   import { makePgTypes } from "temporal-sql/pg";
 *
 *   const pool = new pg.Pool({ connectionString, types: makePgTypes() });
 *
 * `pg` wraps this object in its own `TypeOverrides` and consults it before its
 * defaults, so only queries on this pool see Temporal values. Any OID not in the
 * date/time family — and any non-text wire format — falls through to pg's own
 * parser, unchanged.
 *
 * Prefer this over {@link registerTypeParsers} / {@link registerPassthrough} in
 * library code or in an application that shares a process with other pg users.
 * Those two remain supported and are unaffected by this function.
 *
 * NOT usable with Drizzle. `drizzle-orm/node-postgres` attaches its own `types`
 * object to every query it sends, which wins over the pool's. That object passes
 * through a hard-coded list of OIDs and sends everything else to pg's **global**
 * table, so a pool-scoped table is simply never consulted. Which OIDs are on the
 * list changes between Drizzle versions — 0.36 covers four scalars, 0.45 adds
 * four array OIDs — but `time`, `timetz`, `time[]` and `timetz[]` are on neither.
 * Drizzle therefore needs {@link registerPassthrough} regardless of version.
 * Measured and pinned by `test/integration/pg-scoped-types.test.ts`.
 */
export function makePgTypes(opts: MakePgTypesOptions = {}): PgTypeOverrides {
  const identity = (value: string): string => value;
  const owned = new Map<number, (value: string) => unknown>(
    opts.mode === "passthrough" ? decoders.map(([oid]) => [oid, identity]) : decoders,
  );
  return {
    getTypeParser(oid, format) {
      // Binary results are a different encoding entirely; the codecs read text.
      if (format === undefined || format === "text") {
        const parser = owned.get(oid);
        if (parser) return parser;
      }
      return pgTypes.getTypeParser(oid, format as never) as (value: string) => unknown;
    },
  };
}

/**
 * Encode helpers for query parameters (pg has no serializer registry).
 *
 * The `*Array` helpers return a complete `{...}` array literal, so a parameter
 * cast such as `$1::timestamptz[]` receives text Postgres accepts directly.
 */
export const encode = {
  instant: C.encodeInstant,
  zonedDateTime: C.encodeZonedDateTime,
  plainDateTime: C.encodePlainDateTime,
  plainDate: C.encodePlainDate,
  plainTime: C.encodePlainTime,
  timetz: C.encodeTimetz,
  duration: C.encodeDuration,
  instantArray: (values: readonly (Temporal.Instant | null)[], opts?: EncodeOptions) =>
    C.encodePgArray(values, (v) => C.encodeInstant(v, opts)),
  plainDateTimeArray: (values: readonly (Temporal.PlainDateTime | null)[], opts?: EncodeOptions) =>
    C.encodePgArray(values, (v) => C.encodePlainDateTime(v, opts)),
  plainDateArray: (values: readonly (Temporal.PlainDate | null)[]) =>
    C.encodePgArray(values, (v) => C.encodePlainDate(v)),
  plainTimeArray: (values: readonly (Temporal.PlainTime | null)[], opts?: EncodeOptions) =>
    C.encodePgArray(values, (v) => C.encodePlainTime(v, opts)),
  timetzArray: (values: readonly (TimeWithOffset | null)[], opts?: EncodeOptions) =>
    C.encodePgArray(values, (v) => C.encodeTimetz(v, opts)),
  durationArray: (values: readonly (Temporal.Duration | null)[], opts?: EncodeOptions) =>
    C.encodePgArray(values, (v) => C.encodeDuration(v, opts)),
  zonedDateTimeArray: C.encodeZonedDateTimeArray,
} as const;
