/**
 * Type-level consumer check (CJS arm) — a `.cts` file resolves the `require`
 * condition, so this compiles against the packed `.d.cts` rather than `.d.ts`.
 * That is the arm attw flags as a masquerade risk, so it is worth checking here.
 */
import codecs = require("temporal-sql");
import pgAdapter = require("temporal-sql/pg");

const duration = codecs.decodeDuration("3 days");
const days: number = duration.days;
const iso: string = codecs.encodeDuration(duration);
const intervalOid: number = codecs.OID.interval;
const err: RangeError = new codecs.UnsupportedValueError("x");

const encoded: string = pgAdapter.encode.duration(duration);
pgAdapter.registerTypeParsers();

export type Check = typeof days & typeof iso & typeof intervalOid & typeof encoded;
export { err };
