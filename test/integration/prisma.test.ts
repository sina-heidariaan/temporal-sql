/**
 * Real round-trip through @prisma/adapter-pg (Prisma's driver-adapter path).
 * Gated on DATABASE_URL. Proves the documented Prisma usage end-to-end: write
 * with the codecs, read `::text` columns with $queryRaw, decode with decodeRow.
 *
 * Requires `prisma generate` (run in CI before this test). Skipped when the
 * generated client or DATABASE_URL is absent, so it never breaks a plain run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import pg from "pg";
import { codecs, decodeRow } from "../../src/prisma.js";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const REL = "2000-01-01";

d("prisma (@prisma/adapter-pg) round-trip", () => {
  let pool: pg.Pool;
  // @prisma/client only exists after `prisma generate`; import it lazily so this
  // file stays import-safe (and skippable) when the client isn't generated.
  let prisma: { $executeRawUnsafe: Function; $queryRawUnsafe: Function; $disconnect: () => Promise<void> };

  beforeAll(async () => {
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const { PrismaClient } = await import("@prisma/client");
    pool = new pg.Pool({ connectionString: url });
    const adapter = new PrismaPg(pool);
    prisma = new PrismaClient({ adapter }) as unknown as typeof prisma;
    await prisma.$executeRawUnsafe(`drop table if exists prisma_probe`);
    await prisma.$executeRawUnsafe(
      `create table prisma_probe (at timestamptz, span interval, day date, spans interval[])`,
    );
  });
  afterAll(async () => {
    await prisma.$executeRawUnsafe(`drop table if exists prisma_probe`).catch(() => {});
    await prisma.$disconnect();
    await pool?.end();
  });

  it("writes with codecs, reads ::text, decodes to Temporal", async () => {
    const at = Temporal.Instant.from("2024-03-10T07:30:45.123456Z");
    const span = Temporal.Duration.from("P1Y2M3DT4H5M6.789012S");
    const day = Temporal.PlainDate.from("2024-02-29");

    // Write: pass encoded strings as parameters (Postgres casts them).
    await prisma.$executeRawUnsafe(
      `insert into prisma_probe (at, span, day) values ($1::timestamptz, $2::interval, $3::date)`,
      codecs.encodeInstant(at),
      codecs.encodeDuration(span),
      codecs.encodePlainDate(day),
    );

    // Read: cast to ::text so Prisma hands back raw strings, then decode.
    const rows = (await prisma.$queryRawUnsafe(
      `select at::text, span::text, day::text from prisma_probe`,
    )) as Array<Record<string, unknown>>;
    const mapped = decodeRow<{ at: Temporal.Instant; span: Temporal.Duration; day: Temporal.PlainDate }>(rows[0]!, {
      at: "instant",
      span: "duration",
      day: "plainDate",
    });

    expect(mapped.at.toString()).toBe(at.toString());
    expect(mapped.day.toString()).toBe(day.toString());
    expect(mapped.span.total({ unit: "microseconds", relativeTo: REL })).toBe(
      span.total({ unit: "microseconds", relativeTo: REL }),
    );
  });

  it("writes and reads an array column through decodeRow", async () => {
    const spans = [Temporal.Duration.from("P1Y2M3DT4H5M6.789012S"), null];
    await prisma.$executeRawUnsafe(`delete from prisma_probe`);
    await prisma.$executeRawUnsafe(
      `insert into prisma_probe (spans) values ($1::interval[])`,
      codecs.encodePgArray(spans, (v) => codecs.encodeDuration(v)),
    );

    const rows = (await prisma.$queryRawUnsafe(`select spans::text from prisma_probe`)) as Array<
      Record<string, unknown>
    >;
    const mapped = decodeRow<{ spans: (Temporal.Duration | null)[] }>(rows[0]!, { spans: "durationArray" });

    expect(mapped.spans[1]).toBeNull();
    expect(mapped.spans[0]!.total({ unit: "microseconds", relativeTo: REL })).toBe(
      spans[0]!.total({ unit: "microseconds", relativeTo: REL }),
    );
  });
});
