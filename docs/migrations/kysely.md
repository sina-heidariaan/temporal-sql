# Kysely: Date → Temporal

Kysely is not an adapter of this package — it doesn't need to be. Kysely's
Postgres dialect rides on `pg`, and `pg`'s parser registry is exactly where
`temporal-sql` plugs in. Registration + honest interface types is the whole
migration.

## Before

```ts
interface EventTable {
  id: Generated<number>;
  created_at: Date;      // lies twice: zone intent and µs
  span: string;          // interval has no Date form at all
}
```

## Step 1 — verify

```bash
npx temporal-sql doctor --url $DATABASE_URL
```

## Step 2 — register on the pool Kysely uses

Either process-wide or scoped to Kysely's own pool:

```ts
import pg from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { makePgTypes } from "temporal-sql/pg";

const dialect = new PostgresDialect({
  pool: new pg.Pool({ connectionString, types: makePgTypes() }),
});
const db = new Kysely<Database>({ dialect });
```

(`registerTypeParsers()` works too and affects every pool in the process.)

## Step 3 — tell the interface the truth

```ts
import type { Temporal } from "@js-temporal/polyfill";
import type { TemporalRange } from "temporal-sql";
import type { ColumnType } from "kysely";

interface EventTable {
  id: Generated<number>;
  // select: Temporal.Instant; insert/update: string (the encoded parameter)
  created_at: ColumnType<Temporal.Instant, string, string>;
  span: ColumnType<Temporal.Duration, string, string>;
  stay: ColumnType<TemporalRange<Temporal.PlainDate>, string, string>;
}
```

`ColumnType<Select, Insert, Update>` is the honest shape: selects hand you
Temporal (the parser registry did it), while inserts take the encoded string.

## Step 4 — reads and writes

```ts
const event = await db.selectFrom("events").selectAll().executeTakeFirst();
event.created_at; // Temporal.Instant
event.span;       // Temporal.Duration

import { encode } from "temporal-sql/pg";
await db
  .insertInto("events")
  .values({
    created_at: encode.instant(Temporal.Now.instant()),
    span: encode.duration(Temporal.Duration.from({ hours: 2 })),
    stay: encode.plainDateRange(stay),
  })
  .execute();
```

Postgres casts the parameter text to the column type; add an explicit
`sql`-template cast (`sql`${...}::interval[]``) only where the target type is
ambiguous (array/range literals in some expression positions).

## Pitfalls

- `makePgTypes()` must be on **the pool Kysely uses** — a second pool created
  elsewhere without it still returns `Date`s.
- Kysely's `deleteFrom().where("created_at", "<", …)` comparisons take the
  *insert* type — pass encoded strings, not Temporal objects.
- Migrations/`sql.raw` snippets that format dates via `new Date()` are outside
  the registry; sweep them for `toISOString()` and replace with encoded values.
