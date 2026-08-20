# temporal-sql

> **TC39 Temporal + PostgreSQL correctness — without JS `Date`, timezone
> surprises, or silent precision loss.** Temporal-native PostgreSQL
> **intervals, timestamps, ranges, and multiranges** for `pg`, `postgres.js`,
> Drizzle, and Prisma — plus `temporal-sql doctor` to prove your environment
> is compatible before it bites.

[![npm](https://img.shields.io/npm/v/temporal-sql.svg)](https://www.npmjs.com/package/temporal-sql)
[![license](https://img.shields.io/npm/l/temporal-sql.svg)](./LICENSE)

**Status: early release (v0.x).** Postgres-first. Round-trip tested to
microsecond precision against Postgres 14 and 18 on `pg`, `postgres.js`,
Drizzle, and Prisma (`@prisma/adapter-pg`). Migrating from JS `Date`? There is
a step-by-step [Date → Temporal migration guide](./docs/migrations/) for `pg`,
Drizzle, Prisma, postgres.js, and Kysely.

```bash
npm add temporal-sql
```

`temporal-sql` decodes Postgres date/time values into Temporal objects and
encodes them back — without ever going through JS `Date`. It builds on
[`temporal-gregorian`](https://www.npmjs.com/package/temporal-gregorian), so you
get native `Temporal` on Node 26+ and the polyfill before that, automatically.

## Requirements

Node **18+**, PostgreSQL **14+** tested (everything except multiranges also
works down to 9.2). Driver packages are optional peers — install only the one
you use:

| Peer | Range | Notes |
|------|-------|-------|
| `pg` | `>=8.0.0` | Any `pg` 8.x, ESM or CommonJS. |
| `postgres` | `>=3.4.0` | postgres.js v3 `types` option. |
| `drizzle-orm` | `>=0.30.0` | Uses `customType` from `drizzle-orm/pg-core`. The 1.x beta line is exercised in CI too. |

Each range is installed and executed against the packed tarball in CI, at both
its lower bound and the current release. The full executed matrix — Node ×
Postgres × driver/ORM versions — is in [COMPATIBILITY.md](./COMPATIBILITY.md).

---

## The headline: `interval` and precision

The trivial mappings (`timestamptz`, `date`, `time`) you *could* hand-roll. These
two are the reason this package exists.

### `interval` ⇄ `Temporal.Duration`

Postgres interval text is deceptively hard: multiple output styles, per-field
signs, a single-sign clock component, fractional seconds, and negatives that
`Temporal.Duration.from` outright rejects. `temporal-sql` gets them all right —
and decodes **all four** `IntervalStyle`s Postgres can emit (`postgres`,
`postgres_verbose`, `iso_8601`, `sql_standard`).

```ts
import { decodeDuration, encodeDuration } from "temporal-sql";

decodeDuration("1 year 2 mons 3 days 04:05:06.789012");
//        → Temporal.Duration P1Y2M3DT4H5M6.789012S
decodeDuration("P-3DT-4H-5M-6.5S");   // iso_8601 negative — handled
decodeDuration("+1-2 +3 +4:05:06");   // sql_standard — handled
encodeDuration(Temporal.Duration.from("-P3DT4H"));
//        → "P-3DT-4H"  (per-field signs; a bare "-P…" is rejected by Postgres)
```

Decoding auto-detects the style, so you don't have to know or pin one. If you
want to guarantee a compatible session up front, see
[session compatibility](#session-compatibility).

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
| 4 | No driver ships Temporal support ([prisma#16119](https://github.com/prisma/prisma/issues/16119), postgres.js#856), and schema tooling can't validate custom Temporal columns ([drizzle#5692](https://github.com/drizzle-team/drizzle-orm/issues/5692)) | One package wires `pg`, `postgres.js`, Drizzle, and Prisma — with a [documented drizzle-zod pattern](./docs/migrations/drizzle.md#drizzle-zod) for #5692. |
| 5 | Postgres range types have no native ORM story ([prisma#27975](https://github.com/prisma/prisma/issues/27975)) | `daterange`/`tsrange`/`tstzrange` + multiranges decode to `TemporalRange<T>`. |

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
| `daterange` | `TemporalRange<Temporal.PlainDate>` | Bounds, inclusivity flags, unbounded sides, `empty`. |
| `tsrange` | `TemporalRange<Temporal.PlainDateTime>` | |
| `tstzrange` | `TemporalRange<Temporal.Instant>` | |
| `datemultirange` / `tsmultirange` / `tstzmultirange` | `TemporalRange<T>[]` | Postgres 14+. |

Every scalar type has an **array** form too — `timestamptz[]`, `timestamp[]`,
`date[]`, `time[]`, `timetz[]`, `interval[]` — decoding to `(T | null)[]`. See
[Arrays](#arrays) and [Ranges & multiranges](#ranges--multiranges).

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

**Without mutating pg globally.** `registerTypeParsers()` changes pg's
process-wide parser table, which affects every other pg user in the process. To
confine it to one pool, pass a parser table instead:

```ts
import { makePgTypes } from "temporal-sql/pg";

const pool = new pg.Pool({ connectionString, types: makePgTypes() });
// only this pool decodes to Temporal; every other pool is untouched
```

Any OID outside the date/time family falls through to pg's own parser, unchanged.
This does **not** work with Drizzle — see the note in the Drizzle section.

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
  at:    t.timestamptz("at"),
  span:  t.interval("span", { onSubMicrosecond: "truncate" }),
  spans: t.intervalArray("spans"),   // interval[]
});
```

Every factory also supports the two-call form from earlier releases —
`t.timestamptz()("at")`, `t.interval({ onSubMicrosecond: "truncate" })("span")`
— so no schema needs rewriting.

Using **drizzle-zod**? `createInsertSchema` cannot validate custom Temporal
columns ([drizzle#5692](https://github.com/drizzle-team/drizzle-orm/issues/5692));
the one-line override pattern is documented in
[docs/migrations/drizzle.md](./docs/migrations/drizzle.md#drizzle-zod) and
executed in CI.

> **Why `registerPassthrough()`?** Drizzle's custom columns decode from raw
> text. Without it, `pg` converts the column to a `Date` first and the point of
> the package is lost.
>
> **`makePgTypes()` cannot replace it here.** `drizzle-orm/node-postgres`
> attaches its own `types` to every query, overriding the pool's. That object
> passes through a hard-coded OID list and sends everything else to pg's
> **global** table, so a pool-scoped table is never consulted. The list grows
> between Drizzle versions (0.36 covers four scalars; 0.45 adds four array OIDs),
> but `time`, `timetz`, `time[]` and `timetz[]` are on neither.
> `registerPassthrough()` is the one lever that reaches the global table.
>
> **You can use both at once.** `registerPassthrough()` for Drizzle and
> `makePgTypes()` on your own non-Drizzle pools compose cleanly — see
> [Using both together](#using-both-together).

### Using both together

`registerPassthrough()` and `makePgTypes()` are independent levers, so one app can
use both:

```ts
registerPassthrough();                                  // global: feeds Drizzle raw text
const drizzlePool = new pg.Pool({ connectionString }); // uses the global table
const rawPool = new pg.Pool({ connectionString, types: makePgTypes() });
```

`rawPool` still returns Temporal values. `makePgTypes` answers for the eighteen
date/time OIDs (scalars, arrays, ranges, multiranges) out of its own table and
never consults the global one, so the passthrough cannot leak into it.

The one thing to know: a pool with **no** `types` shares the global table, so
after `registerPassthrough()` it returns raw strings. Give every pool that should
decode its own `makePgTypes()`, or use `registerTypeParsers()` globally instead.

Both `register*` functions also return an undo:

```ts
const restore = registerPassthrough();
// ... later
restore();   // pg's original parsers are back
```

### Prisma (driver-adapter path)

Prisma can't map Temporal in its schema, so use raw SQL + the codecs:

```ts
import { codecs, decodeRow } from "temporal-sql/prisma";

const rows = await prisma.$queryRaw`select id, created_at::text, span::text from events`;
const mapped = rows.map((r) => decodeRow(r, { created_at: "instant", span: "duration" }));
```

---

## Arrays

All six types work as Postgres arrays. Elements go through the same scalar
codecs, so precision and `interval` handling are identical.

```ts
// pg — array OIDs are registered by the same call as the scalars
registerTypeParsers();
const { rows } = await pool.query("select tags, spans from events");
const spans: (Temporal.Duration | null)[] = rows[0].spans;

await pool.query("insert into events (spans) values ($1::interval[])", [
  encode.durationArray([Temporal.Duration.from("P1D"), null]),
]);

// postgres.js — every type has an `*Array` sibling
await sql`insert into events (ats) values (${ sql.typed.instantArray([a, b]) })`;

// Drizzle — explicit array column factories
export const events = pgTable("events", { spans: t.intervalArray()("spans") });

// Prisma — array decoder names
decodeRow(row, { spans: "durationArray" });
```

**A Postgres array can contain SQL `NULL`,** so arrays decode to `(T | null)[]`,
not `T[]`. The distinction between the unquoted token `NULL` and the quoted text
`"NULL"` is preserved in both directions.

The array grammar is parsed properly — quoting, backslash escapes, embedded
commas and braces, empty arrays, and the `[0:2]=` dimension prefix. The reader
and writer are exported if you need them directly:

```ts
import { parsePgArray, formatPgArray } from "temporal-sql";

parsePgArray('{"1 day",NULL,"a,b"}');   // → ["1 day", null, "a,b"]
formatPgArray(["a", null]);             // → '{"a",NULL}'
```

`timestamptz[]` can also be projected onto a zone, the array counterpart of
`decodeZonedDateTime`:

```ts
import { decodeZonedDateTimeArray } from "temporal-sql";
decodeZonedDateTimeArray(text, "Europe/Berlin");   // → (ZonedDateTime | null)[]
```

If the driver already parsed the column, the error says so and names the fix
rather than reporting a malformed literal:

```
Expected Postgres array text but received object. The driver has already parsed
this column. With Drizzle, call registerPassthrough() from "temporal-sql/pg"…
```

> **Multidimensional arrays are not supported by the typed codecs.** Reading one
> throws `UnsupportedValueError` naming the limitation — never a silent
> mis-parse. `parsePgArray` does return the nesting, so you can walk it yourself.

---

## Ranges & multiranges

Postgres range types are the natural model for reservations, availability,
validity periods, and scheduling — and no driver or ORM maps them to anything
usable ([prisma#27975](https://github.com/prisma/prisma/issues/27975)). Here
they decode to a plain, honest object:

```ts
interface TemporalRange<T> {
  lower: T | null;            // null = unbounded
  upper: T | null;
  lowerInclusive: boolean;    // '[' vs '('
  upperInclusive: boolean;    // ']' vs ')'
  empty: boolean;             // the 'empty' range
}
```

| SQL type | Decodes to |
|----------|------------|
| `daterange` | `TemporalRange<Temporal.PlainDate>` |
| `tsrange` | `TemporalRange<Temporal.PlainDateTime>` |
| `tstzrange` | `TemporalRange<Temporal.Instant>` |
| `datemultirange` / `tsmultirange` / `tstzmultirange` | `TemporalRange<T>[]` (Postgres 14+) |

```ts
// pg — range OIDs are registered by the same registerTypeParsers() call
const { rows } = await pool.query("select stay from bookings");
const stay: TemporalRange<Temporal.PlainDate> = rows[0].stay;
// { lower: 2024-01-01, upper: 2024-01-05, lowerInclusive: true, upperInclusive: false, empty: false }

await pool.query("insert into bookings (stay) values ($1::daterange)", [
  encode.plainDateRange({ lower, upper, lowerInclusive: true, upperInclusive: false, empty: false }),
]);

// postgres.js
await sql`insert into bookings (stay) values (${ sql.typed.plainDateRange(stay) })`;

// The grammar helpers are exported too
import { parsePgRange, decodePgRange, decodePgMultirange } from "temporal-sql";
decodePgRange("[2024-01-01,2024-01-05)", decodePlainDate);
decodePgMultirange("{[2024-01-01,2024-01-05),[2024-02-01,2024-02-03)}", decodePlainDate);
```

Full grammar support: `[` `(` / `]` `)` inclusivity, unbounded sides (`(,b]`),
the `empty` range, and quoted/escaped bound values (both `\"` and `""` escape
styles). Multirange text is **not** array text — ranges inside `{...}` are bare
and contain commas — so it gets its own parser, not the array one. Postgres
canonicalizes on input (e.g. `daterange '[a,b]'` → `[a,b+1)`, overlapping
multirange parts merge); what you read back is the canonical form.

Range **operators and query builders are out of scope** — this is a codec, not
an ORM. Encode helpers exist so ranges round-trip: `encode.plainDateRange`,
`encode.plainDateTimeRange`, `encode.instantRange`, and their `*Multirange`
siblings (pg), `sql.typed.plainDateRange` etc. (postgres.js).

---

## `temporal-sql doctor`

One command that proves the whole story — session settings, timezone
independence, microsecond precision, per-type server round-trips, all four
`IntervalStyle`s, and driver/ORM caveats:

```bash
npx temporal-sql doctor --url postgres://localhost/mydb    # or $DATABASE_URL
npx temporal-sql doctor --json       # machine-readable report
npx temporal-sql doctor --markdown   # e.g. >> $GITHUB_STEP_SUMMARY
```

Exit code `0` when every check passes, `1` otherwise — drop it into CI as a
gate. It connects with whichever driver you already have installed (`pg` or
`postgres`).

The engine is importable and driver-agnostic (pass any query lambda, same as
the session helpers):

```ts
import { runDoctor, renderDoctorText } from "temporal-sql/doctor";

const report = await runDoctor((t) => pool.query(t));
if (!report.ok) console.error(renderDoctorText(report));
```

---

## Session compatibility

Decoding auto-detects the interval style, but the `date`/`timestamp` codecs need
an **ISO `DateStyle`** (so values arrive as `YYYY-MM-DD ...`). A non-ISO session
surfaces late, as a per-value parse error. The `temporal-sql/session` helpers
check — or set — a compatible session up front. They take a small query function,
so they work with any driver:

```ts
import { assertTemporalSqlSession, configureTemporalSqlSession } from "temporal-sql/session";

// Throws a clear diagnostic if DateStyle isn't ISO (or IntervalStyle is unknown):
await assertTemporalSqlSession((t) => pool.query(t));           // pg
await assertTemporalSqlSession((t) => sql.unsafe(t));           // postgres.js
await assertTemporalSqlSession((t) => db.execute(sql.raw(t)));  // drizzle

// Or set a known-good session on this connection and return the applied settings:
await configureTemporalSqlSession((t) => pool.query(t), {
  dateStyle: "ISO",        // default
  intervalStyle: "iso_8601", // default; any of the four is accepted
});
```

Both operate **per connection** — a `SET` affects only the session that runs it,
so run them on the specific pooled connection you query on.

## Timezone semantics

`temporal-sql` is timezone-**safe**, not timezone-**preserving** — because
`timestamptz` itself does not preserve a zone:

- `timestamp` → `Temporal.PlainDateTime` — a local wall-clock value, no zone.
- `timestamptz` → `Temporal.Instant` — an exact instant. Postgres stores UTC and
  does **not** retain the original named zone, so neither can we.
- To get a `Temporal.ZonedDateTime`, supply an IANA zone yourself:
  `decodeZonedDateTime(text, "Europe/Berlin")`. The zone is your input, not data
  recovered from the column.

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
- **Arrays are one-dimensional only.** A nested array throws
  `UnsupportedValueError`; use `parsePgArray` to handle nesting yourself.
- **An error in one array element aborts the whole array.** A `PrecisionError`
  while encoding element 3 means no array is written — the same all-or-nothing
  contract the scalar encoders have.

## License

MIT
