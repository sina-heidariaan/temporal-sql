# Prisma: Date → Temporal

Prisma's schema layer cannot map a column to Temporal (`DateTime` is
hard-wired to JS `Date`, [prisma#16119](https://github.com/prisma/prisma/issues/16119)),
and on non-UTC databases `Date` corrupts intent
([prisma#28629](https://github.com/prisma/prisma/issues/28629)). The supported
path is raw SQL for the temporal columns, with `decodeRow` doing the mapping.

## Before

```ts
const event = await prisma.event.findFirst();
event.createdAt; // Date — µs truncated, zone reinterpreted
// interval / range columns: `Unsupported("interval")`, unreadable via the client
```

## Step 1 — verify

```bash
npx temporal-sql doctor --url $DATABASE_URL
```

## Step 2 — read temporal columns via raw SQL + `decodeRow`

Cast each temporal column to `::text` so Prisma hands you the wire text instead
of converting to `Date`, then map:

```ts
import { decodeRow } from "temporal-sql/prisma";

const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
  select id, created_at::text, span::text, spans::text from events`;

const events = rows.map((r) =>
  decodeRow<{ id: number; created_at: Temporal.Instant; span: Temporal.Duration }>(r, {
    created_at: "instant",
    span: "duration",
    spans: "durationArray",
  }),
);
```

Decoder names: `instant`, `plainDateTime`, `plainDate`, `plainTime`, `timetz`,
`duration`, and the `*Array` variants.

## Step 3 — writes

Encode to text and interpolate as a parameter; Postgres casts it:

```ts
import { codecs } from "temporal-sql/prisma";

await prisma.$executeRaw`
  insert into events (created_at, span)
  values (${codecs.encodeInstant(Temporal.Now.instant())}::timestamptz,
          ${codecs.encodeDuration(span)}::interval)`;
```

## Ranges

Prisma has no range support at all
([prisma#27975](https://github.com/prisma/prisma/issues/27975)). Same recipe:

```ts
import { decodePgRange, decodePlainDate } from "temporal-sql";

const rows = await prisma.$queryRaw<{ stay: string }[]>`
  select stay::text from bookings`;
const stay = decodePgRange(rows[0].stay, decodePlainDate);
// { lower: PlainDate, upper: PlainDate, lowerInclusive, upperInclusive, empty }
```

## Keeping the schema honest

For columns you migrate, mark them `Unsupported` in `schema.prisma` so nobody
reads them through the `Date` path by accident:

```prisma
model Event {
  id        Int                          @id @default(autoincrement())
  createdAt Unsupported("timestamptz")?  @map("created_at")
  span      Unsupported("interval")?
}
```

The model still migrates and the raw-SQL path above still reads it; the typed
client simply refuses to touch the field — which is the point.

## Pitfalls

- **Forgetting `::text`** silently reverts you to Prisma's `Date` conversion —
  `decodeRow` leaves non-string fields untouched, so you'll see `Date`s again.
  (That behavior is deliberate: it never double-decodes.)
- `$queryRaw` template values are parameters (safe); the `::text` casts live in
  the SQL text.
- TypedSQL (`prisma.$queryRawTyped`) generates its types from the SQL file and
  offers no custom scalar mapping, so it does not remove any of these steps —
  see `private/experiment-prisma-typedsql-typeorm.md` in the repo for the
  evaluation.
