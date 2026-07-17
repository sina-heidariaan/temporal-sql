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
 */
// Default import, not `import { types } from "pg"`. `pg` is CommonJS, so a named
// import only resolves when Node's cjs-module-lexer can statically detect the
// export — which it cannot before pg 8.15.0, making ESM consumers on older pg
// fail at module load with "does not provide an export named 'types'". The
// default import reads `module.exports` and works on every pg 8.x.
import pg from "pg";
import { OID } from "./oids.js";
import * as C from "./index.js";

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
];

/**
 * Register Temporal decoders for the date/time OIDs, so `SELECT`ed values come
 * back as Temporal objects. `timestamptz` decodes to `Instant` (a `ZonedDateTime`
 * needs a caller-chosen zone, so it can't be auto-registered — use
 * `decodeZonedDateTime` manually).
 */
export function registerTypeParsers(opts: RegisterOptions = {}): void {
  const set = (opts.setTypeParser ?? (pgTypes.setTypeParser as unknown as SetTypeParser));
  for (const [oid, fn] of decoders) set(oid, fn);
}

/**
 * Register identity (raw-text) parsers for the date/time OIDs. Required when the
 * Drizzle adapter is in use so `fromDriver` receives the original string instead
 * of a pg-decoded `Date`.
 */
export function registerPassthrough(opts: RegisterOptions = {}): void {
  const set = (opts.setTypeParser ?? (pgTypes.setTypeParser as unknown as SetTypeParser));
  const identity = (value: string): string => value;
  for (const [oid] of decoders) set(oid, identity);
}

/** Encode helpers for query parameters (pg has no serializer registry). */
export const encode = {
  instant: C.encodeInstant,
  zonedDateTime: C.encodeZonedDateTime,
  plainDateTime: C.encodePlainDateTime,
  plainDate: C.encodePlainDate,
  plainTime: C.encodePlainTime,
  timetz: C.encodeTimetz,
  duration: C.encodeDuration,
} as const;
