import { describe, it, expect } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import { OID } from "../src/oids.js";

describe("pg adapter", () => {
  it("registerTypeParsers sets a decoder per OID", async () => {
    const { registerTypeParsers } = await import("../src/pg.js");
    const seen = new Map<number, (v: string) => unknown>();
    registerTypeParsers({ setTypeParser: (oid, fn) => seen.set(oid, fn) });
    expect([...seen.keys()].sort((a, b) => a - b)).toEqual(
      [OID.timestamptz, OID.timestamp, OID.date, OID.time, OID.timetz, OID.interval].sort((a, b) => a - b),
    );
    const inst = seen.get(OID.timestamptz)!("2024-01-01 12:00:00+00") as Temporal.Instant;
    expect(inst.toString()).toBe("2024-01-01T12:00:00Z");
  });

  it("registerPassthrough returns raw text", async () => {
    const { registerPassthrough } = await import("../src/pg.js");
    const seen = new Map<number, (v: string) => unknown>();
    registerPassthrough({ setTypeParser: (oid, fn) => seen.set(oid, fn) });
    expect(seen.get(OID.interval)!("raw")).toBe("raw");
  });

  it("encode helpers produce SQL text", async () => {
    const { encode } = await import("../src/pg.js");
    expect(encode.instant(Temporal.Instant.from("2024-01-01T00:00:00Z"))).toBe("2024-01-01T00:00:00.000000Z");
  });
});

describe("postgres-js adapter", () => {
  it("exposes {to, from, serialize, parse} per type", async () => {
    const { temporalTypes } = await import("../src/postgres-js.js");
    expect(temporalTypes.instant.to).toBe(OID.timestamptz);
    expect(temporalTypes.duration.from).toEqual([OID.interval]);
    expect(temporalTypes.instant.parse("2024-01-01 00:00:00+00")).toBeDefined();
    expect(temporalTypes.duration.serialize(Temporal.Duration.from({ days: 1 }))).toBe("P1D");
  });
});

describe("drizzle adapter", () => {
  it("factories return callable column builders", async () => {
    const t = await import("../src/drizzle.js");
    // Each factory returns a drizzle customType builder (a function).
    expect(typeof t.timestamptz()).toBe("function");
    expect(typeof t.interval()).toBe("function");
    // Building a named column should not throw.
    expect(() => t.timestamptz()("created_at")).not.toThrow();
  });
});

describe("prisma adapter", () => {
  it("decodeRow maps named string fields to Temporal", async () => {
    const { decodeRow } = await import("../src/prisma.js");
    const row = { id: 1, created_at: "2024-01-01 00:00:00+00", span: "P1D", note: null };
    const out = decodeRow<{ id: number; created_at: Temporal.Instant; span: Temporal.Duration; note: null }>(row, {
      created_at: "instant",
      span: "duration",
    });
    expect(out.id).toBe(1);
    expect(out.note).toBeNull();
    expect(out.created_at.toString()).toBe("2024-01-01T00:00:00Z");
    expect(out.span.days).toBe(1);
  });
});
