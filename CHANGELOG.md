# Changelog

All notable changes to `temporal-sql` are documented here. This project adheres
to [Semantic Versioning](https://semver.org/).

## [0.3.0] — 2026-07-30

Finishes array support. The six array OIDs have been defined in `src/oids.ts`
since 0.1.0 but no adapter registered them, so a `timestamptz[]` column still came
back as JS `Date` objects. All six now decode to Temporal values on every driver.
Also adds a way to decode without mutating `pg` globally.

### Added

- **Array codecs for all six types** — `timestamptz[]`, `timestamp[]`, `date[]`,
  `time[]`, `timetz[]`, `interval[]`. Elements run through the existing scalar
  codecs, so precision behaviour and `IntervalStyle` support are identical to the
  scalar path.
  - `pg` — the array OIDs are registered by the same `registerTypeParsers()` /
    `registerPassthrough()` calls as the scalars. Six new writers:
    `encode.instantArray`, `plainDateTimeArray`, `plainDateArray`,
    `plainTimeArray`, `timetzArray`, `durationArray`.
  - `postgres.js` — six new entries on `temporalTypes` / `makeTemporalTypes`:
    `instantArray`, `plainDateTimeArray`, `plainDateArray`, `plainTimeArray`,
    `timetzArray`, `durationArray`. Registered explicitly rather than relying on
    postgres.js deriving them from `pg_catalog`, so behaviour does not depend on
    a `fetch_types` round trip.
  - Drizzle — six new column factories: `timestamptzArray`, `timestampArray`,
    `dateArray`, `timeArray`, `timetzArray`, `intervalArray`.
  - Prisma — six new `decodeRow` decoder names, e.g. `{ spans: "durationArray" }`.
- **A real Postgres array parser**, exported from the root: `parsePgArray`,
  `formatPgArray`, `decodePgArray`, `encodePgArray`, `type PgArrayElement`.
  Handles quoting, backslash escapes, embedded commas and braces, the unquoted
  `NULL` token versus quoted `"NULL"`, empty arrays, the `[0:2]=` dimension
  prefix, and nesting. Vendored, not a dependency: `dependencies` is unchanged
  and the code stays statically analysable for bundlers.
- **`makePgTypes(opts?)` in `temporal-sql/pg`** — returns a `{ getTypeParser }`
  object for `new pg.Pool({ types })`, so decoding is scoped to one pool instead
  of mutating pg's process-wide table. `mode: "passthrough"` mirrors
  `registerPassthrough`. Any OID outside the date/time family falls through to
  pg's own parser. It composes with a global `registerPassthrough()`, so an app
  can use Drizzle and its own pg pools side by side.
- **Reversible registration.** `registerTypeParsers()` and `registerPassthrough()`
  now return a `restore()` function that puts pg's previous parsers back. Calling
  it twice is a no-op. Previously they returned `void`, so this is additive.
- **`decodeZonedDateTimeArray(text, timeZone)` / `encodeZonedDateTimeArray(values)`**
  — the array counterparts of the `ZonedDateTime` helpers. Like the scalar ones
  they cannot be OID-registered, because the zone is the caller's choice.
  `encode.zonedDateTimeArray` is the `pg` alias.
- **A named diagnostic when the driver already parsed the column.** Passing a
  non-string to `parsePgArray` / `decodePgArray` now throws an error that names
  `registerPassthrough()` as the fix, instead of a bare "expected '{'".

### Changed

- **CI now runs Postgres 18.4** instead of 16. The full suite passes on both.
- `registerTypeParsers()` and `registerPassthrough()` now cover 12 OIDs instead
  of 6. Their signatures and existing behaviour are unchanged.

### Verified

Against **Postgres 18.4**, 255 tests, unit and integration:

- All six array types round-trip on **pg**, **postgres.js**, **Drizzle** and
  **Prisma**, to microsecond precision, asserted by exact value.
- Edge cases: SQL `NULL` elements, empty `{}` arrays, a NULL column (distinct from
  an empty array), BC years in `date[]`, per-element offsets in `timetz[]`, a
  1000-element array, and the `[2:4]=` dimension prefix Postgres emits for a
  non-1 lower bound.
- `interval[]` decodes under **all four `IntervalStyle`s** — `iso_8601` emits bare
  elements, the other three emit quoted ones, and both paths are covered.
- Failures surface correctly *from inside* an array: `infinity` raises
  `UnsupportedValueError`, a mixed-sign interval raises `MixedSignIntervalError`,
  and a multidimensional array names the limitation.
- Drizzle covers all six array columns, including `time[]` and `timetz[]` — the
  OIDs no Drizzle version passes through, so they are the sharpest check that the
  documented `registerPassthrough()` setup is correct.
- The array grammar has 81 unit tests: quoting, escapes, unicode, embedded
  newlines, three-level nesting, a 10,000-element array, and 20 malformed inputs
  that must throw rather than return a partial array.
- A new `test/root-purity.test.ts` pins the acceptance criterion that importing
  the root export or any adapter subpath registers nothing with `pg`.

### Known limitations

- **`makePgTypes` does not work with Drizzle.** `drizzle-orm/node-postgres`
  attaches its own `types` object to every query, which overrides the pool's. It
  passes through a hard-coded OID list and routes everything else to pg's
  **global** table, so a pool-scoped table is never consulted. The list differs by
  version — 0.36 covers four scalars, 0.45 adds four array OIDs — but `time`,
  `timetz`, `time[]` and `timetz[]` are on neither. Drizzle therefore requires
  `registerPassthrough()` at every version. You can still use `makePgTypes` for
  your own non-Drizzle pools in the same process. Pinned by
  `test/integration/pg-scoped-types.test.ts`.
- **Drizzle's newer codec API was not used.** It ships only in `drizzle-orm@1.x`,
  which is still beta (`1.0.0-beta.24`); `latest` is 0.45.2. The `customType`
  factories here work on every version from the declared floor (0.30) to 0.45.2,
  both exercised by the consumer gate.
- **Multidimensional arrays are not supported by the typed codecs.** Reading one
  throws `UnsupportedValueError` naming the limitation rather than mis-mapping it.
  `parsePgArray` does return the nesting for callers who want to walk it.
- An encoder error on one element (e.g. `PrecisionError`) aborts the whole array.

## [0.2.0] — 2026-07-22

Completes `IntervalStyle` coverage and adds session-compatibility helpers.
`decodeDuration` now reads **every** style Postgres can emit, and a new
`temporal-sql/session` subpath turns silent, late format-mismatch parse errors
into a clear, up-front diagnostic.

### Added

- **`sql_standard` interval decoding.** `decodeDuration` now parses the
  SQL-standard output grammar (`±Y-M ±D ±H:M:S[.frac]`, any subset, including the
  bare `0` Postgres emits for a zero interval). Combined with the existing
  `postgres`, `postgres_verbose`, and `iso_8601` support, **all four
  `IntervalStyle`s round-trip.** The year-month sign applies to both fields, and
  mixed-sign combinations across the year-month / day / clock parts still raise
  `MixedSignIntervalError` (routed through the same `finalize` guard). Parsing is
  strict, like the `postgres` tokenizer: misordered, duplicated, or unrecognized
  tokens throw `UnsupportedValueError`.
- **Session helpers — new `temporal-sql/session` subpath.**
  - `assertTemporalSqlSession(query)` inspects `DateStyle`, `IntervalStyle`, and
    `TimeZone`, returns them on success, and throws `UnsupportedValueError` naming
    the offending setting when `DateStyle` is not ISO (the date/timestamp codecs
    require `YYYY-MM-DD` output) or `IntervalStyle` is unrecognized.
  - `configureTemporalSqlSession(query, opts)` sets a known-compatible session
    (`DateStyle = ISO`, `IntervalStyle = iso_8601` by default) on that connection,
    then asserts. Values are allowlisted rather than interpolated, since
    `SET <guc>` cannot be parameterized.
  - Both take a minimal `(sql) => Promise<rows>` query function and normalize both
    result shapes (`{ rows }` for `pg`/Drizzle, a bare array for `postgres.js`), so
    they are driver-agnostic and pull in no peer dependency. They operate **per
    connection** — a `SET` affects only the session that runs it.

### Changed

- **Bare `0` now decodes to a zero `Duration` instead of throwing.** This is the
  zero interval `sql_standard` emits. The v0.1.1 strictness lock that rejected a
  standalone `0` is intentionally inverted; every other zero form
  (`00:00:00`, `@ 0`, `PT0S`) is unchanged.
- **README:** headline now claims *"Supports every PostgreSQL `IntervalStyle`"*;
  added a **Session compatibility** section and a **Timezone semantics** note
  (`timestamp` → `PlainDateTime`, `timestamptz` → `Instant`; Postgres stores UTC
  and does not retain the original named zone — timezone-**safe**, not
  timezone-**preserving**).

### Verified

- `sql_standard` added to the real-Postgres integration matrix: positive,
  negative, year-month-only, day-time-only, zero, and mixed values round-trip
  under `SET intervalstyle` across all four styles, and a mixed-sign
  `sql_standard` value still trips `MixedSignIntervalError`.
- New `temporal-sql/session` subpath resolves cleanly (`attw` node16 CJS+ESM +
  bundler) and is exercised through the packed-consumer gate (ESM/CJS/types ×
  min+latest peers).

## [0.1.2] — 2026-07-17

### Fixed

- **`temporal-sql/pg` now works on any `pg` 8.x, ESM or CommonJS.** The adapter
  used `import { types } from "pg"`. `pg` is CommonJS, and a *named* import from
  CJS only resolves when Node's `cjs-module-lexer` can statically detect the
  export — which it cannot before `pg@8.15.0`. ESM consumers on older `pg` failed
  at module load with *"does not provide an export named 'types'"*. The adapter
  now uses a default import (`import pg from "pg"`), which reads `module.exports`
  and works across all of `pg` 8.x.

### Changed

- **`pg` peer range relaxed from `>=8.15.0` back to `>=8.0.0`.** The 0.1.1 floor
  was compensating for the named import above rather than describing a real
  incompatibility. Because `peerDependencies` ranges are enforced even when
  `peerDependenciesMeta.optional` is set, that floor caused npm to **fail
  installs outright** (`ERESOLVE`) for anyone pinned to `pg` 8.0–8.14 — including
  CommonJS users whose setup worked fine. Both bounds are now installed and run
  by the consumer gate.

## [0.1.1] — 2026-07-17

Correctness and packaging. `decodeDuration` now honors its documented contract —
unparseable input throws instead of silently returning a wrong `Duration` — and
the published tarball is tested the way real consumers install it.

### Fixed

- **`decodeDuration` no longer accepts malformed input.** The `postgres`-style
  parser searched for each field independently, so it would harvest whatever it
  recognized and ignore the rest. It is now a strict left-to-right tokenizer that
  requires at least one component, rejects unrecognized text anywhere in the
  string, and rejects duplicate fields. Previously these returned a wrong value;
  all now throw `UnsupportedValueError`:

  | Input | Before | Now |
  | --- | --- | --- |
  | `""` | `PT0S` | throws |
  | `"nonsense"` | `PT0S` | throws |
  | `"1 day trailing"` | `P1D` | throws |
  | `"garbage 1 day"` | `P1D` | throws |
  | `"1 day 2 days"` | `P2D` | throws |
  | `"P"` | `PT0S` | throws |

- **Bare `P` in the ISO-8601 path.** Every field group was optional, so `"P"`,
  `"PT"`, and sign-only `"-P"` matched and returned `PT0S`. ISO-8601 requires at
  least one component; they now throw `UnsupportedValueError`.

### Changed

- **`peerDependencies` narrowed from `"*"` to tested ranges:** `pg >=8.15.0`,
  `drizzle-orm >=0.30.0`, `postgres >=3.4.0`. All remain optional.
  **Superseded by 0.1.2** — the `pg` floor was misdiagnosed and is relaxed back to
  `>=8.0.0` there. Prefer 0.1.2.
- **`prepublishOnly` now runs the full release gate** (`typecheck`, `test`,
  `build`, `attw`, and the packed-consumer tests) instead of `build` alone, so a
  publish fails if any gate fails.

### Added

- **Packed-consumer tests** (`npm run test:consumers`). Installs the `npm pack`
  tarball into clean throwaway projects and exercises it as a real dependant
  would: ESM `import`, CJS `require`, and a TypeScript project type-checked
  against the published `.d.ts`/`.d.cts` under node16 resolution — each against
  both the minimum and latest supported peer versions.
- **Node 24 and 26 in CI.** Node 26 ships Temporal natively, so the suite now
  runs against native Temporal as well as the polyfill.

### Verified

- `decodeDuration` checked against **PostgreSQL 16.14** across 30 interval values
  × all three `IntervalStyle` settings (90 combinations), comparing every decoded
  field against Postgres's own `extract()` rather than against our parser.
- Behavior on real `interval_out` output is unchanged, including the
  `postgres_verbose` zero interval (`@ 0`) and per-field-sign negatives.

## [0.1.0] — 2026-07-14

Initial release. Postgres-first codecs mapping SQL date/time types to TC39
Temporal, with adapters for `pg`, `postgres.js`, Drizzle, and Prisma. No JS
`Date` in any code path.

### Added

- **Pure codecs** for six Postgres types:
  - `timestamptz` ⇄ `Temporal.Instant` (default) / `ZonedDateTime`
  - `timestamp` ⇄ `Temporal.PlainDateTime`
  - `date` ⇄ `Temporal.PlainDate` (BC years and years ≥ 10000 handled)
  - `time` ⇄ `Temporal.PlainTime`
  - `timetz` ⇄ `{ time, offset }`
  - `interval` ⇄ `Temporal.Duration`
- **`interval` ⇄ `Duration`** handling the default `postgres`, `postgres_verbose`,
  and `iso_8601` styles, including per-field-sign negatives; rejects mixed-sign
  intervals (`MixedSignIntervalError`) and `sql_standard` output rather than
  silently misparsing.
- **Microsecond-precision safety.** `encode*` throws `PrecisionError` on
  sub-microsecond (nanosecond) input by default; opt into truncation with
  `{ onSubMicrosecond: "truncate" }`. Decode is lossless to microseconds.
- **Driver adapters:** `temporal-sql/pg` (`registerTypeParsers`,
  `registerPassthrough`, `encode.*`), `temporal-sql/postgres-js` (`temporalTypes`,
  `makeTemporalTypes`), `temporal-sql/drizzle` (`customType` factories), and
  `temporal-sql/prisma` (`codecs`, `decodeRow`).
- **`infinity` / `-infinity`** and BC timestamps are rejected with
  `UnsupportedValueError` rather than producing a wrong value.

### Verified

- Round-trip insert → select to microsecond precision against **Postgres 16** on
  **pg**, **Drizzle**, **postgres.js**, and **Prisma** (`@prisma/adapter-pg`).
- Dual ESM/CJS build; `attw` clean for node16 (CJS + ESM) and bundler resolution.

### Known limitations

- Postgres only (no MySQL/SQLite yet); array types not wired (fixed in 0.3.0);
  `timetz` returns a struct rather than a Temporal type; Drizzle requires
  `registerPassthrough()` (mutates pg's global type-parser state). See the README
  caveats section.

[0.3.0]: https://github.com/sina-heidariaan/temporal-sql/releases/tag/v0.3.0
[0.2.0]: https://github.com/sina-heidariaan/temporal-sql/releases/tag/v0.2.0
[0.1.2]: https://github.com/sina-heidariaan/temporal-sql/releases/tag/v0.1.2
[0.1.1]: https://github.com/sina-heidariaan/temporal-sql/releases/tag/v0.1.1
[0.1.0]: https://github.com/sina-heidariaan/temporal-sql/releases/tag/v0.1.0
