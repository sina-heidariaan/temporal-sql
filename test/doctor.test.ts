import { describe, it, expect } from "vitest";
import { runDoctor, renderDoctorText, renderDoctorMarkdown } from "../src/doctor.js";
import type { SessionQuery } from "../src/session.js";

/**
 * A fake Postgres session: answers exactly the queries the doctor issues, with
 * the text a real ISO/UTC Postgres 18 session produces (verified against the
 * integration environment). SET statements mutate the fake's state so the
 * IntervalStyle and TimeZone probes exercise the restore logic too.
 */
function fakeSession(overrides: { dateStyle?: string; serverVersion?: string } = {}) {
  const state = {
    dateStyle: overrides.dateStyle ?? "ISO, MDY",
    intervalStyle: "postgres",
    timeZone: "UTC",
  };
  const log: string[] = [];

  // What `SELECT interval '1 year 2 mons 3 days 04:05:06.789012'::text` prints per style.
  const INTERVALS: Record<string, string> = {
    postgres: "1 year 2 mons 3 days 04:05:06.789012",
    postgres_verbose: "@ 1 year 2 mons 3 days 4 hours 5 mins 6.789012 secs",
    iso_8601: "P1Y2M3DT4H5M6.789012S",
    sql_standard: "+1-2 +3 +4:05:06.789012",
  };

  // Literal probes → server text (an ISO session echoes these back canonically).
  const SELECTS: Record<string, string> = {
    "SELECT '2024-01-01 12:34:56.123456+00'::timestamptz::text": "2024-01-01 12:34:56.123456+00",
    "SELECT '2024-01-01T12:34:56.123456Z'::timestamptz::text": "2024-01-01 12:34:56.123456+00",
    "SELECT '2024-01-01 12:34:56.123456'::timestamp::text": "2024-01-01 12:34:56.123456",
    "SELECT '2024-02-29'::date::text": "2024-02-29",
    "SELECT '23:59:59.999999'::time::text": "23:59:59.999999",
    "SELECT '12:00:00.000001+05:30'::timetz::text": "12:00:00.000001+05:30",
  };

  const query: SessionQuery = async (sql) => {
    log.push(sql);
    const t = sql.trim();
    const show = /^SHOW (\w+)$/i.exec(t);
    if (show) {
      const name = show[1]!.toLowerCase();
      if (name === "datestyle") return [{ DateStyle: state.dateStyle }];
      if (name === "intervalstyle") return [{ IntervalStyle: state.intervalStyle }];
      if (name === "timezone") return [{ TimeZone: state.timeZone }];
      if (name === "server_version") return [{ server_version: overrides.serverVersion ?? "18.4" }];
      throw new Error(`fake: unknown SHOW ${name}`);
    }
    const set = /^SET (\w+) = '([^']*)'$/i.exec(t);
    if (set) {
      const name = set[1]!.toLowerCase();
      if (name === "intervalstyle") state.intervalStyle = set[2]!;
      else if (name === "timezone") state.timeZone = set[2]!;
      else throw new Error(`fake: unknown SET ${name}`);
      return [];
    }
    if (t === "SELECT interval '1 year 2 mons 3 days 04:05:06.789012'::text") {
      const text = INTERVALS[state.intervalStyle];
      if (!text) throw new Error(`fake: no interval rendering for style ${state.intervalStyle}`);
      return [{ text }];
    }
    if (t === "SELECT '2024-06-01 00:00:00+00'::timestamptz::text") {
      // Rendering depends on the session TimeZone — the point of the probe.
      if (state.timeZone === "UTC") return [{ text: "2024-06-01 00:00:00+00" }];
      if (state.timeZone === "Asia/Tokyo") return [{ text: "2024-06-01 09:00:00+09" }];
      throw new Error(`fake: no tstz rendering for zone ${state.timeZone}`);
    }
    const known = SELECTS[t];
    if (known !== undefined) return [{ text: known }];
    throw new Error(`fake: unexpected query: ${t}`);
  };

  return { query, state, log };
}

describe("runDoctor", () => {
  it("passes every check against a compatible session", async () => {
    const session = fakeSession();
    const report = await runDoctor(session.query, { packages: { pg: "8.13.0", "drizzle-orm": null } });

    expect(report.ok).toBe(true);
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    for (const id of [
      "connectivity",
      "session-datestyle",
      "session-intervalstyle",
      "session-timezone",
      "server-version",
      "precision-guard",
      "roundtrip-timestamptz",
      "roundtrip-timestamp",
      "roundtrip-date",
      "roundtrip-time",
      "roundtrip-timetz",
      "timezone-independence",
      "interval-styles",
      "driver-compat",
    ]) {
      expect(byId[id]?.status, id).toBe("pass");
    }
    // The probes must put the session back the way they found it.
    expect(session.state.intervalStyle).toBe("postgres");
    expect(session.state.timeZone).toBe("UTC");
  });

  it("fails the DateStyle check and skips the text-dependent probes on a non-ISO session", async () => {
    const session = fakeSession({ dateStyle: "German, DMY" });
    const report = await runDoctor(session.query);

    expect(report.ok).toBe(false);
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId["session-datestyle"]?.status).toBe("fail");
    expect(byId["session-datestyle"]?.detail).toContain("SET DateStyle = 'ISO'");
    expect(byId["roundtrip-date"]?.status).toBe("skip");
    expect(byId["timezone-independence"]?.status).toBe("skip");
  });

  it("warns (not fails) on a pre-14 server, where multiranges are missing", async () => {
    const session = fakeSession({ serverVersion: "13.11" });
    const report = await runDoctor(session.query);
    const check = report.checks.find((c) => c.id === "server-version")!;
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("14");
    expect(report.ok).toBe(true); // a warning alone must not flip the exit code
  });

  it("reports an unreachable database as one failed connectivity check", async () => {
    const report = await runDoctor(async () => {
      throw new Error("connection refused");
    });
    expect(report.ok).toBe(false);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]!.id).toBe("connectivity");
    expect(report.checks[0]!.detail).toContain("connection refused");
  });
});

describe("renderers", () => {
  it("text and markdown renderers include every check and the verdict", async () => {
    const session = fakeSession();
    const report = await runDoctor(session.query, { packages: { pg: "8.13.0" } });

    const text = renderDoctorText(report);
    expect(text).toContain("temporal-sql doctor");
    expect(text).toContain("✓ DateStyle is ISO");
    expect(text).toContain("compatible");

    const md = renderDoctorMarkdown(report);
    expect(md).toContain("| Check | Status | Detail |");
    expect(md).toContain("| DateStyle is ISO | pass |");
    expect(md.startsWith("# temporal-sql doctor — compatible")).toBe(true);
  });
});
