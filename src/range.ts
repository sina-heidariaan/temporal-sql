/**
 * PostgreSQL range / multirange literal ⇄ Temporal-typed range objects.
 *
 * Postgres renders a range column as one text value — `[2024-01-01,2024-01-05)`,
 * `("2024-01-01 00:00:00","2024-01-02 12:00:00"]`, `empty` — and a multirange as
 * ranges inside braces: `{[a,b),[c,d)}`. This module reads and writes that
 * grammar in full: bound inclusivity (`[` `(` / `]` `)`), the `empty` range,
 * unbounded (missing) bounds, and quoted bounds with both escape styles Postgres
 * accepts (`\x` and `""`).
 *
 * Deliberately NOT built on the array parser in `array.ts`: multirange text is
 * not array text. Range literals inside `{...}` are unquoted and contain commas
 * and brackets of their own, so the array grammar would split them apart. The
 * splitter below tracks range brackets and bound quoting instead.
 *
 * Like every codec here, malformed text throws instead of quietly returning a
 * partial value.
 */
import { UnsupportedValueError } from "./shared.js";

/**
 * A decoded Postgres range.
 *
 * `lower` / `upper` are `null` when that side is unbounded. An `empty` range
 * (a range that contains no points) has both bounds `null` and both
 * inclusivity flags `false`.
 *
 * Note Postgres canonicalizes discrete ranges on input — `daterange '[a,b]'`
 * comes back as `[a,b+1)` — so the flags reflect what the server stored, not
 * necessarily what was written.
 */
export interface TemporalRange<T> {
  lower: T | null;
  upper: T | null;
  lowerInclusive: boolean;
  upperInclusive: boolean;
  empty: boolean;
}

/** {@link TemporalRange} with the bounds still in raw Postgres text. */
export type RawRange = TemporalRange<string>;

function fail(text: string, position: number, why: string): never {
  throw new UnsupportedValueError(
    `Malformed Postgres range literal at position ${position}: ${why}. Value: ${JSON.stringify(text)}`,
  );
}

/**
 * Read one bound starting at `i` in `text`, ending at an unquoted `,` or at the
 * end of the string. Returns the bound text (`null` when the bound is absent,
 * i.e. unbounded) and the index of the terminator.
 *
 * Quoting follows `range_in`: a bound may be wrapped in `"..."`, inside which
 * `""` is a literal quote and `\x` is a literal `x`; outside quotes `\x` also
 * escapes. Unquoted whitespace around a bound is not significant.
 */
function readBound(text: string, i: number): { value: string | null; end: number; quoted: boolean } {
  let out = "";
  let quoted = false;
  let sawContent = false;
  // Unquoted whitespace is only data when more content follows it (`a b`), so
  // buffer it and flush lazily — leading/trailing whitespace is then dropped
  // for free, which is what `range_in` does.
  let pendingSpace = "";
  const flush = (): void => {
    if (sawContent) out += pendingSpace;
    pendingSpace = "";
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === " " || ch === "\t") {
      pendingSpace += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      flush();
      quoted = true;
      sawContent = true;
      i++; // opening quote
      for (;;) {
        if (i >= text.length) fail(text, i, "unterminated quoted bound");
        const q = text[i]!;
        if (q === "\\") {
          if (i + 1 >= text.length) fail(text, i, "trailing backslash");
          out += text[i + 1]!;
          i += 2;
          continue;
        }
        if (q === '"') {
          if (text[i + 1] === '"') {
            out += '"'; // doubled quote — the SQL-style escape range_in accepts
            i += 2;
            continue;
          }
          i++; // closing quote
          break;
        }
        out += q;
        i++;
      }
      continue;
    }
    if (ch === "\\") {
      if (i + 1 >= text.length) fail(text, i, "trailing backslash");
      flush();
      out += text[i + 1]!;
      sawContent = true;
      i += 2;
      continue;
    }
    if (ch === ",") break;
    flush();
    out += ch;
    sawContent = true;
    i++;
  }
  return { value: sawContent ? out : null, end: i, quoted };
}

/**
 * Parse a Postgres range literal into a {@link RawRange} — bounds kept as text.
 *
 * | Input | Result |
 * |---|---|
 * | `empty` | `empty: true`, both bounds `null` |
 * | `[a,b)` | inclusive lower, exclusive upper |
 * | `(,b]` | unbounded lower |
 * | `(,)` | fully unbounded |
 * | `["a b","c,d"]` | quoted bounds; commas and spaces are data |
 *
 * @throws {UnsupportedValueError} on missing/invalid bound brackets, an
 *   unterminated quote, or trailing text.
 */
export function parsePgRange(text: string): RawRange {
  if (typeof text !== "string") {
    throw new UnsupportedValueError(
      `Expected Postgres range text but received ${text === null ? "null" : typeof text}. ` +
        "The driver has already parsed this column.",
    );
  }
  const t = text.trim();
  if (t.toLowerCase() === "empty") {
    return { lower: null, upper: null, lowerInclusive: false, upperInclusive: false, empty: true };
  }

  const open = t[0];
  if (open !== "[" && open !== "(") fail(text, 0, "expected '[', '(' or 'empty'");
  const close = t[t.length - 1];
  if (close !== "]" && close !== ")") fail(text, t.length - 1, "expected ']' or ')'");

  const inner = t.slice(1, -1);
  const lower = readBound(inner, 0);
  if (inner[lower.end] !== ",") fail(text, lower.end + 1, "expected ',' between the bounds");
  const upper = readBound(inner, lower.end + 1);
  if (upper.end !== inner.length) fail(text, upper.end + 1, "unexpected text after the upper bound");

  return {
    lower: lower.value,
    upper: upper.value,
    lowerInclusive: open === "[",
    upperInclusive: close === "]",
    empty: false,
  };
}

/**
 * Decode a range literal, running each present bound through `decode` —
 * the entry point the driver adapters use.
 *
 *   decodePgRange("[2024-01-01,2024-01-05)", decodePlainDate)
 *   // → { lower: PlainDate, upper: PlainDate, lowerInclusive: true, … }
 */
export function decodePgRange<T>(text: string, decode: (bound: string) => T): TemporalRange<T> {
  const raw = parsePgRange(text);
  return {
    lower: raw.lower === null ? null : decode(raw.lower),
    upper: raw.upper === null ? null : decode(raw.upper),
    lowerInclusive: raw.lowerInclusive,
    upperInclusive: raw.upperInclusive,
    empty: raw.empty,
  };
}

/** Quote a bound unconditionally — `range_in` accepts a quoted bound anywhere. */
const quoteBound = (bound: string): string => `"${bound.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Render a {@link RawRange} as a Postgres range literal. `empty: true` renders
 * as `empty`; a `null` bound renders as absent (unbounded). Non-null bounds are
 * always quoted, so any bound text round-trips.
 */
export function formatPgRange(range: RawRange): string {
  if (range.empty) return "empty";
  const open = range.lowerInclusive ? "[" : "(";
  const close = range.upperInclusive ? "]" : ")";
  const lower = range.lower === null ? "" : quoteBound(range.lower);
  const upper = range.upper === null ? "" : quoteBound(range.upper);
  return `${open}${lower},${upper}${close}`;
}

/**
 * Encode a range of Temporal values as a Postgres range literal, running each
 * present bound through `encode`. Errors from `encode` (notably `PrecisionError`)
 * propagate — the same all-or-nothing contract the scalar encoders have.
 */
export function encodePgRange<T>(range: TemporalRange<T>, encode: (bound: T) => string): string {
  return formatPgRange({
    lower: range.lower === null ? null : encode(range.lower),
    upper: range.upper === null ? null : encode(range.upper),
    lowerInclusive: range.lowerInclusive,
    upperInclusive: range.upperInclusive,
    empty: range.empty,
  });
}

/**
 * Split a Postgres multirange literal (`{}`, `{[a,b)}`, `{[a,b),(c,d]}`) into
 * its individual range literals, still as text.
 *
 * Ranges inside the braces are bare (not quoted like array elements), so this
 * walks each range from its opening bracket to its matching close bracket,
 * honoring quoted bounds so a `)` or `]` inside a bound doesn't end the range.
 */
export function splitPgMultirange(text: string): string[] {
  if (typeof text !== "string") {
    throw new UnsupportedValueError(
      `Expected Postgres multirange text but received ${text === null ? "null" : typeof text}. ` +
        "The driver has already parsed this column.",
    );
  }
  const t = text.trim();
  if (t[0] !== "{") fail(text, 0, "expected '{'");
  if (t[t.length - 1] !== "}") fail(text, t.length - 1, "expected '}'");
  const inner = t.slice(1, -1).trim();
  if (inner.length === 0) return [];

  const ranges: string[] = [];
  let i = 0;
  for (;;) {
    while (i < inner.length && (inner[i] === " " || inner[i] === "\t")) i++;
    const start = i;
    const open = inner[i];
    if (open !== "[" && open !== "(") fail(text, start + 1, "expected '[' or '(' to start a range");
    i++;
    let inQuote = false;
    for (;;) {
      if (i >= inner.length) fail(text, i + 1, "unterminated range (unbalanced bracket)");
      const ch = inner[i]!;
      if (ch === "\\") {
        if (i + 1 >= inner.length) fail(text, i + 1, "trailing backslash");
        i += 2;
        continue;
      }
      if (ch === '"') {
        // `""` inside a quoted bound is an escaped quote, not a close-then-open.
        if (inQuote && inner[i + 1] === '"') {
          i += 2;
          continue;
        }
        inQuote = !inQuote;
        i++;
        continue;
      }
      if (!inQuote && (ch === "]" || ch === ")")) {
        i++;
        break;
      }
      i++;
    }
    ranges.push(inner.slice(start, i));

    while (i < inner.length && (inner[i] === " " || inner[i] === "\t")) i++;
    if (i >= inner.length) return ranges;
    if (inner[i] !== ",") fail(text, i + 1, `expected ',' between ranges but found ${JSON.stringify(inner[i])}`);
    i++;
  }
}

/**
 * Decode a multirange literal into an array of {@link TemporalRange}, running
 * each bound through `decode`. `{}` decodes to `[]`.
 */
export function decodePgMultirange<T>(text: string, decode: (bound: string) => T): TemporalRange<T>[] {
  return splitPgMultirange(text).map((range) => decodePgRange(range, decode));
}

/**
 * Encode an array of ranges as a Postgres multirange literal. Postgres merges
 * overlapping/adjacent ranges and drops empty ones on input, so what you read
 * back is the canonical form, not necessarily this exact text.
 */
export function encodePgMultirange<T>(
  ranges: readonly TemporalRange<T>[],
  encode: (bound: T) => string,
): string {
  return `{${ranges.map((range) => encodePgRange(range, encode)).join(",")}}`;
}
