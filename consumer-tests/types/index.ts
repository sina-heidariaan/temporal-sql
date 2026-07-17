/**
 * Type-level consumer check (ESM arm) — compiled against the packed `.d.ts`
 * under node16 resolution. Nothing here runs; `tsc --noEmit` is the assertion.
 */
import {
  decodeDuration,
  encodeDuration,
  decodeInstant,
  decodePlainDate,
  decodeTimetz,
  UnsupportedValueError,
  MixedSignIntervalError,
  PrecisionError,
  OID,
  type EncodeOptions,
  type TimeWithOffset,
} from "temporal-sql";
import { registerTypeParsers, encode, type RegisterOptions } from "temporal-sql/pg";
import { temporalTypes, makeTemporalTypes } from "temporal-sql/postgres-js";
import { interval, timestamptz } from "temporal-sql/drizzle";

// Inferred return types must be the real Temporal types, not `any`.
const duration = decodeDuration("3 days");
const days: number = duration.days;
const iso: string = encodeDuration(duration);

const instant = decodeInstant("2024-01-01 12:00:00+00");
const epoch: bigint = instant.epochNanoseconds;

const plainDate = decodePlainDate("2024-01-01");
const year: number = plainDate.year;

const timetzValue: TimeWithOffset = decodeTimetz("12:00:00+02");
const offset: string = timetzValue.offset;

// EncodeOptions must flow through the encode helpers.
const opts: EncodeOptions = { onSubMicrosecond: "truncate" };
const encoded: string = encodeDuration(duration, opts);

// Errors are constructible and are RangeErrors.
const errors: RangeError[] = [
  new UnsupportedValueError("x"),
  new MixedSignIntervalError("x"),
  new PrecisionError("x"),
];

const intervalOid: number = OID.interval;

// Adapter subpaths.
const registerOpts: RegisterOptions = {};
registerTypeParsers(registerOpts);
const encodedViaPg: string = encode.duration(duration);
const configured = makeTemporalTypes(opts);
const configuredOid: number = configured.instant.to;

// `serialize` is typed against the Temporal value; `parse` is declared
// `(raw: string) => unknown`, so consumers must narrow it themselves. Asserted
// as-published rather than as-desired — see the v0.1.1 notes.
const serialized: string = temporalTypes.duration.serialize(duration);
const parsed: unknown = temporalTypes.duration.parse("3 days");
const fromOids: number[] = temporalTypes.duration.from;

// Drizzle column factories return callable builders.
const intervalColumn = interval();
const timestamptzColumn = timestamptz(opts);

export type Check = typeof days &
  typeof iso &
  typeof epoch &
  typeof year &
  typeof offset &
  typeof encoded &
  typeof intervalOid &
  typeof encodedViaPg &
  typeof serialized &
  typeof configuredOid;
export { errors, parsed, fromOids, intervalColumn, timestamptzColumn };
