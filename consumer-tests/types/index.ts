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
  parsePgArray,
  formatPgArray,
  decodePgArray,
  encodePgArray,
  decodeZonedDateTimeArray,
  encodeZonedDateTimeArray,
  parsePgRange,
  formatPgRange,
  decodePgRange,
  encodePgRange,
  splitPgMultirange,
  decodePgMultirange,
  encodePgMultirange,
  decodePlainDateTime,
  type EncodeOptions,
  type TimeWithOffset,
  type PgArrayElement,
  type TemporalRange,
  type RawRange,
} from "temporal-sql";
import {
  registerTypeParsers,
  makePgTypes,
  encode,
  type RegisterOptions,
  type PgTypeOverrides,
  type PgTypesMode,
  type RestoreTypeParsers,
} from "temporal-sql/pg";
import { temporalTypes, makeTemporalTypes } from "temporal-sql/postgres-js";
import { interval, timestamptz, intervalArray, timestamptzArray } from "temporal-sql/drizzle";
import {
  assertTemporalSqlSession,
  configureTemporalSqlSession,
  type SessionQuery,
  type SessionDiagnostic,
} from "temporal-sql/session";
import {
  runDoctor,
  renderDoctorText,
  renderDoctorMarkdown,
  type DoctorReport,
  type DoctorCheck,
  type DoctorStatus,
} from "temporal-sql/doctor";

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

// Drizzle column factories return callable builders (two-call form)…
const intervalColumn = interval();
const timestamptzColumn = timestamptz(opts);
const intervalArrayColumn = intervalArray();
const timestamptzArrayColumn = timestamptzArray(opts);
// …and build named columns directly (single-call form, v0.4.0).
const namedTimestamptz = timestamptz("created_at");
const namedInterval = interval("window", opts);

// Ranges & multiranges (v0.4.0): typed bounds, raw grammar, and encode helpers.
const dateRange: TemporalRange<ReturnType<typeof decodePlainDate>> = decodePgRange(
  "[2024-01-01,2024-01-05)",
  decodePlainDate,
);
const lowerYear: number | undefined = dateRange.lower?.year;
const rawRange: RawRange = parsePgRange("(,)");
const rangeLiteral: string = formatPgRange(rawRange);
const encodedRange: string = encodePgRange(dateRange, (v) => v.toString());
const rawRanges: string[] = splitPgMultirange("{}");
const tsRanges: TemporalRange<ReturnType<typeof decodePlainDateTime>>[] = decodePgMultirange(
  "{}",
  decodePlainDateTime,
);
const encodedMulti: string = encodePgMultirange(tsRanges, (v) => v.toString());
const encodedInstantRange: string = encode.instantRange(
  { lower: instant, upper: null, lowerInclusive: true, upperInclusive: false, empty: false },
  opts,
);

// Doctor: the report and check shapes are typed.
const doctorQuery: SessionQuery = async () => ({ rows: [{ DateStyle: "ISO, MDY" }] });
const doctorPromise: Promise<DoctorReport> = runDoctor(doctorQuery, { packages: { pg: "8.13.0" } });
const statusValue: DoctorStatus = "pass";
const checkShape: Pick<DoctorCheck, "id" | "status"> = { id: "connectivity", status: statusValue };
const textRenderer: (r: DoctorReport) => string = renderDoctorText;
const mdRenderer: (r: DoctorReport) => string = renderDoctorMarkdown;

// Arrays: the grammar helpers and the typed element mapping.
const elements: PgArrayElement[] = parsePgArray('{"1 day",NULL}');
const literal: string = formatPgArray(elements);
// A Postgres array may hold SQL NULL, so decoding must widen the element type.
const decodedSpans: (ReturnType<typeof decodeDuration> | null)[] = decodePgArray("{}", decodeDuration);
const encodedSpans: string = encodePgArray([duration, null], (v) => encodeDuration(v));

// `encode.*Array` accept nulls alongside values and return array-literal text.
const encodedArray: string = encode.durationArray([duration, null], opts);

// Per-pool parser table.
const mode: PgTypesMode = "passthrough";
const scopedTypes: PgTypeOverrides = makePgTypes({ mode });
const scopedParser: (value: string) => unknown = scopedTypes.getTypeParser(OID.intervalArray, "text");

// Registration is reversible; the undo is typed.
const restore: RestoreTypeParsers = registerTypeParsers();
restore();

// ZonedDateTime arrays need a caller-supplied zone, like the scalar helpers.
const zonedList = decodeZonedDateTimeArray('{"2024-01-01 00:00:00+00"}', "Europe/Berlin");
const zonedText: string = encodeZonedDateTimeArray(zonedList);

// Session subpath: the query function and returned diagnostic are typed.
const sessionQuery: SessionQuery = async () => ({ rows: [{ DateStyle: "ISO, MDY" }] });
const sessionDiag: Promise<SessionDiagnostic> = assertTemporalSqlSession(sessionQuery);
const configured2: Promise<SessionDiagnostic> = configureTemporalSqlSession(sessionQuery, { intervalStyle: "iso_8601" });

export type Check = typeof days &
  typeof iso &
  typeof epoch &
  typeof year &
  typeof offset &
  typeof encoded &
  typeof intervalOid &
  typeof encodedViaPg &
  typeof serialized &
  typeof configuredOid &
  typeof literal &
  typeof encodedSpans &
  typeof encodedArray &
  typeof zonedText;
export {
  errors,
  parsed,
  fromOids,
  intervalColumn,
  timestamptzColumn,
  intervalArrayColumn,
  timestamptzArrayColumn,
  namedTimestamptz,
  namedInterval,
  sessionDiag,
  configured2,
  elements,
  decodedSpans,
  scopedTypes,
  scopedParser,
  zonedList,
  dateRange,
  lowerYear,
  rawRange,
  rangeLiteral,
  encodedRange,
  rawRanges,
  tsRanges,
  encodedMulti,
  encodedInstantRange,
  doctorPromise,
  checkShape,
  textRenderer,
  mdRenderer,
};
