# Changelog

All notable changes to `temporal-sql` are documented here. This project adheres
to [Semantic Versioning](https://semver.org/).

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
  `drizzle-orm >=0.30.0`, `postgres >=3.4.0`. All remain optional. The `pg` floor
  is not cosmetic: earlier releases break `import { types } from "pg"` for ESM
  consumers with *"does not provide an export named 'types'"*, which
  `temporal-sql/pg` does at module load. CommonJS works further back, but
  `peerDependencies` cannot express a per-module-system floor.
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

- Postgres only (no MySQL/SQLite yet); array types not wired; `timetz` returns a
  struct rather than a Temporal type; Drizzle requires `registerPassthrough()`
  (mutates pg's global type-parser state). See the README caveats section.

[0.1.1]: https://github.com/sina-heidariaan/temporal-sql/releases/tag/v0.1.1
[0.1.0]: https://github.com/sina-heidariaan/temporal-sql/releases/tag/v0.1.0
