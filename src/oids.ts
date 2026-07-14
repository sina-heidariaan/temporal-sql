/**
 * Postgres type OIDs for the date/time family, plus their array OIDs.
 *
 * These are stable, built-in catalog OIDs (`pg_type.oid`) — the same numbers
 * `pg-types` and `postgres.js` key their parsers on. Hard-coding them is how the
 * driver ecosystem does it; they do not change across Postgres versions.
 */
export const OID = {
  timestamptz: 1184,
  timestamptzArray: 1185,
  timestamp: 1114,
  timestampArray: 1115,
  date: 1082,
  dateArray: 1182,
  time: 1083,
  timeArray: 1183,
  timetz: 1266,
  timetzArray: 1270,
  interval: 1186,
  intervalArray: 1187,
} as const;

export type Oid = (typeof OID)[keyof typeof OID];
