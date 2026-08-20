# Compatibility matrix

Every cell in this document is **executed**, not claimed. The last column names
the CI job (`.github/workflows/ci.yml`) or script that runs it — if a
combination is not listed here, we have not run it, and the README does not
claim it.

Run the whole matrix locally with:

```bash
npm run check            # typecheck + unit tests + build + attw
npm run test:consumers   # packed-tarball consumers, min + latest peers
DATABASE_URL=postgres://… npm test        # adds the live-Postgres round-trips
npx temporal-sql doctor --url postgres://…  # one-shot environment check
```

## Node.js

| Node | What runs | Where |
|------|-----------|-------|
| 18 | typecheck, unit tests, build | CI `check` matrix |
| 20 | typecheck, unit tests, build | CI `check` matrix |
| 22 | everything incl. attw, consumers, integration, doctor | all CI jobs |
| 24 | typecheck, unit tests, build | CI `check` matrix |
| 26 | typecheck, unit tests, build — **native `Temporal`**, no polyfill | CI `check` matrix |

Node 26 matters: `Temporal` is enabled natively there, so the suite runs on
both the polyfill (≤24) and the real implementation (26).

## PostgreSQL

| Postgres | What runs | Where |
|----------|-----------|-------|
| 14 | full integration round-trips (`pg`, postgres.js, Drizzle, Prisma, ranges, multiranges) + `temporal-sql doctor` | CI `integration` matrix |
| 18.4 | same | CI `integration` matrix |

Postgres 14 is the tested floor because multiranges were added in 14.
Everything except multiranges uses features stable since 9.2 (ranges) or
earlier (scalars, arrays), and the doctor reports a per-server verdict — run it
against your instance for an authoritative answer.

## Drivers and ORMs

Peer ranges are honest bounds: both ends are installed against the **packed
tarball** and executed (`scripts/check-consumers.mjs`), not just declared.

| Package | Tested versions | Scalars | Arrays | Ranges | Multiranges | Where |
|---------|-----------------|:-:|:-:|:-:|:-:|-------|
| `pg` | 8.0.0 and latest 8.x | ✓ | ✓ | ✓ | ✓ | consumers `min`/`latest`, CI `integration` |
| `postgres` (postgres.js) | 3.4.x | ✓ | ✓ | ✓ | ✓ | consumers, CI `integration` |
| `drizzle-orm` | 0.30.0 and latest 0.x | ✓ (columns) | ✓ (columns) | — | — | consumers `min`/`latest`, CI `integration` |
| `drizzle-orm` | 1.0 beta (codec line) | ✓ (columns) | ✓ (columns) | — | — | consumers `drizzle-beta` (CI, non-blocking) |
| `drizzle-zod` | latest | override pattern for [drizzle#5692](https://github.com/drizzle-team/drizzle-orm/issues/5692) | | | | consumers `latest` (`drizzle-zod` fixture) |
| `@prisma/client` + `@prisma/adapter-pg` | 5.22.x | ✓ (raw SQL + `decodeRow`) | ✓ | manual (`::text` + `decodePgRange`) | manual | CI `integration` (`test/integration/prisma.test.ts`) |

Notes:

- **Drizzle ranges**: no range column factories yet — Drizzle users can read
  range columns as text (`customType` + `decodePgRange`) today; native
  factories are a candidate for a later release.
- **drizzle-orm 1.0 beta** tracks the upstream `beta` dist-tag on purpose. It
  runs as a separate CI job with `continue-on-error`, so an upstream beta break
  is visible without blocking releases here.
- **Kysely** is not an adapter (it rides on `pg`'s parser registry) — see the
  [Kysely migration guide](./docs/migrations/kysely.md), which shows the
  supported setup.

## Interval styles and session settings

All four `IntervalStyle`s (`postgres`, `postgres_verbose`, `iso_8601`,
`sql_standard`) are decoded; `DateStyle` must be `ISO` (the default
everywhere). Both are verified per-connection by
`assertTemporalSqlSession` / `temporal-sql doctor`, and exercised against a
live server in CI (`test/integration/roundtrip.test.ts`, doctor step).
