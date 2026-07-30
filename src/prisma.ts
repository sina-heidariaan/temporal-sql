/**
 * Prisma helper (driver-adapter path).
 *
 * Prisma cannot map columns to Temporal in its schema, so there is no schema
 * type here. Instead: run raw SQL through `@prisma/adapter-pg` + `$queryRaw`,
 * get text back, and map it with the codecs below. Write with `codecs.encode*`
 * and interpolate the string; read with {@link decodeRow}.
 *
 *   import { PrismaPg } from "@prisma/adapter-pg";
 *   import { codecs, decodeRow } from "temporal-sql/prisma";
 *
 *   const rows = await prisma.$queryRaw`select id, created_at::text, span::text from t`;
 *   const mapped = rows.map((r) => decodeRow(r, { created_at: "instant", span: "duration" }));
 */
import * as codecs from "./index.js";

export { codecs };

const DECODERS = {
  instant: codecs.decodeInstant,
  plainDateTime: codecs.decodePlainDateTime,
  plainDate: codecs.decodePlainDate,
  plainTime: codecs.decodePlainTime,
  timetz: codecs.decodeTimetz,
  duration: codecs.decodeDuration,
  // Array columns, cast to `::text` like the scalar ones. Elements may be SQL
  // NULL, so these produce `(T | null)[]`.
  instantArray: (v: string) => codecs.decodePgArray(v, codecs.decodeInstant),
  plainDateTimeArray: (v: string) => codecs.decodePgArray(v, codecs.decodePlainDateTime),
  plainDateArray: (v: string) => codecs.decodePgArray(v, codecs.decodePlainDate),
  plainTimeArray: (v: string) => codecs.decodePgArray(v, codecs.decodePlainTime),
  timetzArray: (v: string) => codecs.decodePgArray(v, codecs.decodeTimetz),
  durationArray: (v: string) => codecs.decodePgArray(v, codecs.decodeDuration),
} as const;

/** Name of a decoder in {@link DECODERS}. */
export type DecoderName = keyof typeof DECODERS;

/**
 * Return a shallow copy of `row` with the named string fields decoded to their
 * Temporal types. Non-string / null fields are left untouched (so `NULL`
 * columns survive). Cast the columns to `::text` in your query so Prisma hands
 * you raw strings rather than its own `Date` conversion.
 */
export function decodeRow<T = Record<string, unknown>>(
  row: Record<string, unknown>,
  map: Record<string, DecoderName>,
): T {
  const out: Record<string, unknown> = { ...row };
  for (const [key, name] of Object.entries(map)) {
    const value = row[key];
    if (typeof value === "string") out[key] = DECODERS[name](value);
  }
  return out as T;
}
