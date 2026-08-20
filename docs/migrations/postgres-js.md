# postgres.js: Date → Temporal

postgres.js decodes date/time columns to JS `Date` by default, and has a clean
extension point (`types`) that replaces it wholesale — no globals involved.

## Before

```ts
const sql = postgres(url);
const rows = await sql`select created_at, span from events`;
rows[0].created_at; // Date
rows[0].span;       // postgres.js's own interval object — not a Duration
```

## Step 1 — verify

```bash
npx temporal-sql doctor --url $DATABASE_URL
```

(The doctor uses your installed `postgres` package if `pg` isn't present.)

## Step 2 — pass the type map

```ts
import postgres from "postgres";
import { temporalTypes } from "temporal-sql/postgres-js";

const sql = postgres(url, { types: temporalTypes });
```

To configure precision behavior, build the map yourself:

```ts
import { makeTemporalTypes } from "temporal-sql/postgres-js";
const sql = postgres(url, { types: makeTemporalTypes({ onSubMicrosecond: "truncate" }) });
```

## After

```ts
const rows = await sql`select created_at, span, stay from events`;
rows[0].created_at; // Temporal.Instant
rows[0].span;       // Temporal.Duration
rows[0].stay;       // TemporalRange<Temporal.PlainDate>  (daterange column)
```

## Step 3 — writes go through `sql.typed.*`

```ts
await sql`insert into events (created_at, span) values (
  ${sql.typed.instant(Temporal.Now.instant())},
  ${sql.typed.duration(Temporal.Duration.from({ hours: 2 }))}
)`;

// arrays and ranges have siblings:
sql.typed.instantArray([a, b]);        // timestamptz[]
sql.typed.plainDateRange(stay);        // daterange
sql.typed.instantMultirange(windows);  // tstzmultirange
```

## Sweep the call sites

Same table as the [pg guide](./pg.md#step-4--sweep-the-call-sites):
`getTime()` → `epochMilliseconds`, `toISOString()` → `toString()`,
`Date` comparisons → `Temporal.Instant.compare`.

## Pitfalls

- **Untyped inserts still work** (`${myInstant.toString()}` with a cast), but
  `sql.typed.*` is what routes the value through the precision guard — prefer
  it.
- The `types` option applies per `postgres()` instance; every instance you
  create needs it.
- `fetch_types` derivation is not relied on: all 18 OIDs (scalars, arrays,
  ranges, multiranges) are registered explicitly, so behavior is deterministic.
- Mixed-sign intervals and sub-µs writes throw the same honest errors as every
  other adapter (`MixedSignIntervalError`, `PrecisionError`).
