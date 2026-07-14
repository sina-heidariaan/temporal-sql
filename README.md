# temporal-sql

> Postgres ⇄ TC39 **Temporal** codecs for `pg`, `postgres.js`, Drizzle, and
> Prisma. Correct `interval`↔`Duration`, microsecond-precision safety, and **no
> JavaScript `Date`** anywhere.

[![npm](https://img.shields.io/npm/v/temporal-sql.svg)](https://www.npmjs.com/package/temporal-sql)
[![license](https://img.shields.io/npm/l/temporal-sql.svg)](./LICENSE)

**Status: early release (v0.x).** Postgres-first. Round-trip tested to
microsecond precision against Postgres 16 on `pg`, `postgres.js`, Drizzle, and
Prisma (`@prisma/adapter-pg`).

```bash
npm add temporal-sql
```

`temporal-sql` decodes Postgres date/time values into Temporal objects and
encodes them back — without ever going through JS `Date`. It builds on
[`temporal-gregorian`](https://www.npmjs.com/package/temporal-gregorian), so you
get native `Temporal` on Node 26+ and the polyfill before that, automatically.

---

## The headline: `interval` and precision

The trivial mappings (`timestamptz`, `date`, `time`) you *could* hand-roll. These
two are the reason this package exists.

### `interval` ⇄ `Temporal.Duration`

Postgres interval text is deceptively hard: multiple output styles, per-field
signs, a single-sign clock component, fractional seconds, and negatives that
`Temporal.Duration.from` outright rejects. `temporal-sql` gets them all right.

```ts
import { decodeDuration, encodeDuration } from "temporal-sql";

decodeDuration("1 year 2 mons 3 days 04:05:06.789012");
//        → Temporal.Duration P1Y2M3DT4H5M6.789012S
decodeDuration("P-3DT-4H-5M-6.5S");   // Postgres iso_8601 negative — handled
encodeDuration(Temporal.Duration.from("-P3DT4H"));
//        → "P-3DT-4H"  (per-field signs; a bare "-P…" is rejected by Postgres)
```

A Postgres interval like `1 mon -3 days` **cannot** be represented as one
`Temporal.Duration` (months vs days are calendar-ambiguous). Rather than corrupt
it, we throw `MixedSignIntervalError` so you can decide.

### Microsecond precision, surfaced — never silently dropped

Postgres stores microseconds; Temporal is nanosecond. Naive `.toString()`
silently corrupts data. `temporal-sql` **throws by default** when you try to
write sub-microsecond precision:

```ts
import { encodeInstant, PrecisionError } from "temporal-sql";

const t = Temporal.Instant.from("2024-01-01T00:00:00.000000123Z");
encodeInstant(t);                                   // throws PrecisionError
encodeInstant(t, { onSubMicrosecond: "truncate" }); // opt in to drop the ns tail
```

Decode is always lossless to microseconds.

---

## The four problems it solves

| # | Problem | What we do |
|---|---------|-----------|
| 1 | JS `Date` mangles timezone intent on non-UTC databases ([prisma#28629](https://github.com/prisma/prisma/issues/28629), [#26786](https://github.com/prisma/prisma/issues/26786)) | `Date` never appears in any code path — `timestamptz` decodes to `Temporal.Instant`. |
| 2 | `interval` has no sane JS representation | Correct, tested `interval`↔`Duration` incl. negatives, fractions, mixed-sign rejection. |
| 3 | Silent microsecond↔nanosecond precision loss | Precision is surfaced (throws by default), never dropped quietly. |
| 4 | No driver ships Temporal support ([prisma#16119](https://github.com/prisma/prisma/issues/16119), [drizzle#5692](https://github.com/drizzle-team/drizzle-orm/issues/5692), postgres.js#856) | One package wires `pg`, `postgres.js`, Drizzle, and Prisma. |

---

## Type mapping

| SQL type | Temporal type | Notes |
|----------|---------------|-------|
| `timestamptz` | `Temporal.Instant` (default) / `ZonedDateTime` | `timestamptz` carries no IANA zone; `Instant` is faithful. For `ZonedDateTime`, supply the zone. |
| `timestamp` | `Temporal.PlainDateTime` | |
| `date` | `Temporal.PlainDate` | BC years and years ≥ 10000 handled. |
| `time` | `Temporal.PlainTime` | |
| `timetz` | `{ time: PlainTime, offset }` | Temporal has no time+offset type; a struct avoids silent offset loss. |
| `interval` | `Temporal.Duration` | Mixed-sign intervals throw rather than corrupt. |

---

## Before / after

```ts
// Before — JS Date loses zone intent and can't hold microseconds cleanly
const { rows } = await pool.query("select created_at from events");
const when: Date = rows[0].created_at; // which zone? what about µs?

// After — a real instant, lossless to microseconds
import { registerTypeParsers } from "temporal-sql/pg";
registerTypeParsers();
const { rows } = await pool.query("select created_at from events");
const when: Temporal.Instant = rows[0].created_at;
```

---

## Per-driver usage

### `pg` (node-postgres)

```ts
import { registerTypeParsers, encode } from "temporal-sql/pg";

registerTypeParsers();               // SELECTed date/time columns → Temporal
await pool.query("insert into events (at) values ($1)", [
  encode.instant(Temporal.Now.instant()),
]);
```

`pg` has no serializer registry, so encode values explicitly with `encode.*` and
pass the string as a parameter.

### `postgres.js`

```ts
import postgres from "postgres";
import { temporalTypes } from "temporal-sql/postgres-js";

const sql = postgres(url, { types: temporalTypes });
await sql`insert into events (at) values (${ sql.typed.instant(myInstant) })`;
```

### Drizzle ORM

```ts
import { pgTable } from "drizzle-orm/pg-core";
import * as t from "temporal-sql/drizzle";
import { registerPassthrough } from "temporal-sql/pg";

registerPassthrough(); // REQUIRED: hands Drizzle raw text, not a pg Date

export const events = pgTable("events", {
  at:   t.timestamptz()("at"),
  span: t.interval({ onSubMicrosecond: "truncate" })("span"),
});
```

> **Why `registerPassthrough()`?** Drizzle's custom columns decode from raw
> text. Without it, `pg` converts the column to a `Date` first and the point of
> the package is lost.

### Prisma (driver-adapter path)

Prisma can't map Temporal in its schema, so use raw SQL + the codecs:

```ts
import { codecs, decodeRow } from "temporal-sql/prisma";

const rows = await prisma.$queryRaw`select id, created_at::text, span::text from events`;
const mapped = rows.map((r) => decodeRow(r, { created_at: "instant", span: "duration" }));
```

---

## Precision & caveats

- **Microseconds only on write.** Postgres cannot store nanoseconds. Encoding a
  sub-µs value throws `PrecisionError` unless `{ onSubMicrosecond: "truncate" }`.
- **`timestamptz` has no zone name.** It decodes to `Instant` by default; use
  `decodeZonedDateTime(text, timeZone)` when you want a `ZonedDateTime`.
- **`timetz` is discouraged by Postgres** (offset without a date is DST-ambiguous).
  We return `{ time, offset }`; `decodeTimetzTime` is available if you knowingly
  want the lossy time-only value.
- **`infinity` / `-infinity`** timestamps have no Temporal value and throw
  `UnsupportedValueError`.

## License

MIT
