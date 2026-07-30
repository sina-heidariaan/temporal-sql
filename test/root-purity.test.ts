/**
 * The root import must have no side effects.
 *
 * `package.json` declares `sideEffects: false` and the adapters mutate pg's
 * global parser table on purpose. If merely importing `temporal-sql` (or an
 * adapter subpath) ever registered parsers at module-evaluation time, every
 * other pg user in the process would silently start receiving Temporal objects.
 * This file is the guard against that regression.
 *
 * It runs in its own file so no other test's `registerTypeParsers()` call can
 * pollute the observation — vitest isolates each test file in its own module
 * registry and worker.
 */
import { describe, it, expect } from "vitest";
import pg from "pg";
import pgTypes from "pg-types";
import { OID } from "../src/oids.js";

/** pg's untouched default parser for an OID, taken before anything imports us. */
const defaultsBefore = new Map<number, unknown>(
  Object.values(OID).map((oid) => [oid, pg.types.getTypeParser(oid)]),
);

describe("root import purity", () => {
  it("importing the root export registers nothing with pg", async () => {
    await import("../src/index.js");
    for (const [oid, before] of defaultsBefore) {
      expect(pg.types.getTypeParser(oid), `OID ${oid}`).toBe(before);
    }
  });

  it("importing the adapter subpaths registers nothing either", async () => {
    await import("../src/pg.js");
    await import("../src/postgres-js.js");
    await import("../src/drizzle.js");
    await import("../src/prisma.js");
    await import("../src/session.js");
    for (const [oid, before] of defaultsBefore) {
      expect(pg.types.getTypeParser(oid), `OID ${oid}`).toBe(before);
    }
  });

  it("makePgTypes does not touch the global table", async () => {
    const { makePgTypes } = await import("../src/pg.js");
    makePgTypes();
    makePgTypes({ mode: "passthrough" });
    for (const [oid, before] of defaultsBefore) {
      expect(pg.types.getTypeParser(oid), `OID ${oid}`).toBe(before);
    }
  });

  it("registerTypeParsers with an injected setter does not touch the global table", async () => {
    const { registerTypeParsers } = await import("../src/pg.js");
    registerTypeParsers({ setTypeParser: () => {} });
    for (const [oid, before] of defaultsBefore) {
      expect(pg.types.getTypeParser(oid), `OID ${oid}`).toBe(before);
    }
  });

  it("the baseline itself is meaningful (pg really does own these OIDs)", () => {
    // Guards against the whole suite passing because getTypeParser always
    // returned the same identity function regardless of registration.
    expect(pgTypes.getTypeParser(OID.timestamptz)).not.toBe(pgTypes.getTypeParser(OID.interval));
  });
});
