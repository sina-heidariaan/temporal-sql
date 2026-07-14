# Changelog

All notable changes to `temporal-sql` are documented here. This project adheres
to [Semantic Versioning](https://semver.org/).

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

- Postgres only (no MySQL/SQLite yet); array types not wired; `timetz` returns a
  struct rather than a Temporal type; Drizzle requires `registerPassthrough()`
  (mutates pg's global type-parser state). See the README caveats section.

[0.1.0]: https://github.com/sina-heidariaan/temporal-sql/releases/tag/v0.1.0
