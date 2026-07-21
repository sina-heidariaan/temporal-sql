import { describe, it, expect } from "vitest";
import {
  assertTemporalSqlSession,
  configureTemporalSqlSession,
  type SessionQuery,
  type SessionResult,
} from "../src/session.js";
import { UnsupportedValueError } from "../src/shared.js";

/**
 * A fake connection whose `SHOW` responses reflect a mutable settings map, so
 * `configure*` (which issues `SET`) and a subsequent `assert*` interact the way
 * a real session would — without a database.
 *
 * `shape` picks which driver result shape to return: `{ rows }` (pg/Drizzle) or
 * a bare row array (postgres.js). Both must normalize identically.
 */
function fakeSession(
  initial: Record<string, string>,
  shape: "rows" | "array" = "rows",
): { query: SessionQuery; sets: string[]; settings: Record<string, string> } {
  const settings = { ...initial };
  const sets: string[] = [];
  const wrap = (row: Record<string, unknown>): SessionResult =>
    shape === "rows" ? { rows: [row] } : [row];

  const query: SessionQuery = async (sql) => {
    const showMatch = /^SHOW\s+(\w+)$/i.exec(sql);
    if (showMatch) {
      const key = showMatch[1]!.toLowerCase();
      const found = Object.entries(settings).find(([k]) => k.toLowerCase() === key);
      // `SHOW` names the column after the setting; value read by position anyway.
      return wrap({ [showMatch[1]!]: found ? found[1] : "" });
    }
    const setMatch = /^SET\s+(\w+)\s*=\s*'([^']*)'$/i.exec(sql);
    if (setMatch) {
      sets.push(sql);
      settings[setMatch[1]!] = setMatch[2]!;
      return wrap({});
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  return { query, sets, settings };
}

describe("assertTemporalSqlSession", () => {
  it("returns the observed settings on a compatible session", async () => {
    const { query } = fakeSession({ DateStyle: "ISO, MDY", IntervalStyle: "iso_8601", TimeZone: "UTC" });
    const diag = await assertTemporalSqlSession(query);
    expect(diag).toEqual({ dateStyle: "ISO, MDY", intervalStyle: "iso_8601", timeZone: "UTC" });
  });

  it("accepts all four interval styles", async () => {
    for (const style of ["postgres", "postgres_verbose", "iso_8601", "sql_standard"]) {
      const { query } = fakeSession({ DateStyle: "ISO, DMY", IntervalStyle: style, TimeZone: "UTC" });
      await expect(assertTemporalSqlSession(query)).resolves.toMatchObject({ intervalStyle: style });
    }
  });

  it("throws an actionable diagnostic naming DateStyle when it is not ISO", async () => {
    const { query } = fakeSession({ DateStyle: "SQL, MDY", IntervalStyle: "iso_8601", TimeZone: "UTC" });
    await expect(assertTemporalSqlSession(query)).rejects.toThrow(UnsupportedValueError);
    await expect(assertTemporalSqlSession(query)).rejects.toThrow(/DateStyle.*ISO/s);
  });

  it("throws naming IntervalStyle when it is unrecognized", async () => {
    const { query } = fakeSession({ DateStyle: "ISO, MDY", IntervalStyle: "klingon", TimeZone: "UTC" });
    await expect(assertTemporalSqlSession(query)).rejects.toThrow(/IntervalStyle.*klingon/s);
  });

  it("normalizes the bare-array result shape (postgres.js) too", async () => {
    const { query } = fakeSession({ DateStyle: "ISO, MDY", IntervalStyle: "postgres", TimeZone: "UTC" }, "array");
    await expect(assertTemporalSqlSession(query)).resolves.toMatchObject({ intervalStyle: "postgres" });
  });

  it("accepts a bare 'ISO' DateStyle with no order token", async () => {
    const { query } = fakeSession({ DateStyle: "ISO", IntervalStyle: "iso_8601", TimeZone: "UTC" });
    await expect(assertTemporalSqlSession(query)).resolves.toMatchObject({ dateStyle: "ISO" });
  });

  it("throws on an unrecognized result shape", async () => {
    const query: SessionQuery = async () => ({ data: [] }) as unknown as SessionResult;
    await expect(assertTemporalSqlSession(query)).rejects.toThrow(/unrecognized shape/);
  });

  it("throws when SHOW returns no rows", async () => {
    const query: SessionQuery = async () => ({ rows: [] });
    await expect(assertTemporalSqlSession(query)).rejects.toThrow(/no rows/);
  });
});

describe("configureTemporalSqlSession", () => {
  it("makes an incompatible session pass a subsequent assert", async () => {
    const session = fakeSession({ DateStyle: "German, DMY", IntervalStyle: "postgres", TimeZone: "UTC" });
    await expect(assertTemporalSqlSession(session.query)).rejects.toThrow(UnsupportedValueError);

    const diag = await configureTemporalSqlSession(session.query);
    expect(diag).toMatchObject({ dateStyle: "ISO", intervalStyle: "iso_8601" });
    await expect(assertTemporalSqlSession(session.query)).resolves.toBeDefined();
  });

  it("does not SET TimeZone when it is omitted", async () => {
    const session = fakeSession({ DateStyle: "German, DMY", IntervalStyle: "postgres", TimeZone: "UTC" });
    await configureTemporalSqlSession(session.query);
    expect(session.sets).toEqual(["SET DateStyle = 'ISO'", "SET IntervalStyle = 'iso_8601'"]);
  });

  it("issues SET for each requested setting", async () => {
    const session = fakeSession({ DateStyle: "ISO", IntervalStyle: "postgres", TimeZone: "UTC" });
    await configureTemporalSqlSession(session.query, { intervalStyle: "sql_standard", timeZone: "Europe/Berlin" });
    expect(session.sets).toEqual([
      "SET DateStyle = 'ISO'",
      "SET IntervalStyle = 'sql_standard'",
      "SET TimeZone = 'Europe/Berlin'",
    ]);
  });

  it("rejects a non-allowlisted intervalStyle rather than interpolating it", async () => {
    const session = fakeSession({ DateStyle: "ISO", IntervalStyle: "postgres", TimeZone: "UTC" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(configureTemporalSqlSession(session.query, { intervalStyle: "bogus" as any })).rejects.toThrow(
      UnsupportedValueError,
    );
    expect(session.sets).toEqual([]);
  });

  it("rejects a malformed timeZone rather than interpolating it", async () => {
    const session = fakeSession({ DateStyle: "ISO", IntervalStyle: "postgres", TimeZone: "UTC" });
    await expect(configureTemporalSqlSession(session.query, { timeZone: "UTC'; DROP TABLE t; --" })).rejects.toThrow(
      UnsupportedValueError,
    );
  });
});
