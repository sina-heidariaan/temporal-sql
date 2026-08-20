# Date → Temporal migration guides

Step-by-step guides for moving a codebase off JS `Date` and onto TC39
`Temporal` for every Postgres date/time column, per driver/ORM:

- [`pg` (node-postgres)](./pg.md)
- [Drizzle ORM](./drizzle.md) — including the drizzle-zod pattern for [drizzle#5692](https://github.com/drizzle-team/drizzle-orm/issues/5692)
- [Prisma](./prisma.md)
- [postgres.js](./postgres-js.md)
- [Kysely](./kysely.md)

The shape is the same everywhere:

1. **Verify the environment** — `npx temporal-sql doctor --url $DATABASE_URL`.
2. **Register the codecs** for your driver (one call at startup).
3. **Replace `Date` at the boundaries** — column types, query parameters,
   serialization.
4. **Handle the two honest errors** — `MixedSignIntervalError` (an interval
   like `1 mon -3 days` has no single `Duration`) and `PrecisionError`
   (Temporal is nanosecond, Postgres is microsecond; decide `truncate` or fix
   the value).

Why migrate at all? `Date` is a millisecond UTC timestamp pretending to be
everything else. Concretely:

| Column | With `Date` | With Temporal |
|--------|-------------|---------------|
| `timestamptz` | zone intent lost, µs truncated | `Temporal.Instant`, µs-lossless |
| `timestamp` | silently reinterpreted through the server/process zone | `Temporal.PlainDateTime` — a wall-clock value, no zone attached |
| `date` | becomes midnight in *some* zone; off-by-one-day bugs | `Temporal.PlainDate` |
| `time` | unrepresentable | `Temporal.PlainTime` |
| `interval` | unrepresentable (strings or ad-hoc objects) | `Temporal.Duration`, all four IntervalStyles |
| `daterange` / `tstzrange` | unrepresentable | `TemporalRange<T>` |
