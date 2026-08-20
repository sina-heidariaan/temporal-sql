# pg (node-postgres): Date → Temporal

`pg` decodes every date/time column to a JS `Date` by default. One call swaps
that for Temporal, process-wide or per-pool.

## Before

```ts
const { rows } = await pool.query("select created_at, duration from events");
rows[0].created_at; // Date — which zone? µs already truncated
rows[0].duration;   // string like "3 days" — pg has no interval mapping
```

## Step 1 — verify the environment

```bash
npx temporal-sql doctor --url $DATABASE_URL
```

## Step 2 — register the codecs

Process-wide (simplest; affects every pool in the process):

```ts
import { registerTypeParsers } from "temporal-sql/pg";
registerTypeParsers(); // once, at startup, before the first query
```

Or confined to one pool (library code, shared processes):

```ts
import { makePgTypes } from "temporal-sql/pg";
const pool = new pg.Pool({ connectionString, types: makePgTypes() });
```

## After

```ts
const { rows } = await pool.query("select created_at, duration from events");
rows[0].created_at; // Temporal.Instant     — exact moment, µs-lossless
rows[0].duration;   // Temporal.Duration    — P3D
```

## Step 3 — writes

`pg` has no serializer registry, so encode explicitly and pass the string:

```ts
import { encode } from "temporal-sql/pg";

await pool.query("insert into events (created_at, duration) values ($1, $2)", [
  encode.instant(Temporal.Now.instant()),
  encode.duration(Temporal.Duration.from({ hours: 2 })),
]);
```

Arrays and ranges take a parameter cast: `$1::interval[]` with
`encode.durationArray([...])`, `$1::daterange` with `encode.plainDateRange(...)`.

## Step 4 — sweep the call sites

Mechanical replacements:

| Before (`Date`) | After (Temporal) |
|---|---|
| `row.at.getTime()` | `row.at.epochMilliseconds` |
| `row.at.toISOString()` | `row.at.toString()` |
| `new Date()` as a parameter | `encode.instant(Temporal.Now.instant())` |
| `date-fns` / manual zone math on `timestamptz` | `row.at.toZonedDateTimeISO("Europe/Berlin")` |
| comparing `Date`s | `Temporal.Instant.compare(a, b)` |

## Pitfalls

- **Order matters**: register before the first query, or early rows still
  arrive as `Date`.
- **`timestamp` (no tz) is now a `PlainDateTime`**, not an instant. If your old
  code treated it as UTC, that was the bug this migration removes — decide what
  zone those wall-clock values mean and convert explicitly.
- **Mixed-sign intervals** (`1 mon -3 days`) throw `MixedSignIntervalError`
  instead of guessing. Catch it where such data is legal and decide.
- **Sub-microsecond writes throw** `PrecisionError`. Pass
  `{ onSubMicrosecond: "truncate" }` to `encode.*` where truncation is intended.
- Undo at any time: `registerTypeParsers()` returns a restore function.
