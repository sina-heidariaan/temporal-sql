/**
 * PostgreSQL array literal ⇄ JavaScript array.
 *
 * Postgres renders an array column as one text value: `{"1 day","2 mons"}`.
 * Splitting that on commas is wrong — elements may be quoted, may contain commas
 * and quotes of their own, may be the unquoted token `NULL`, and may nest. This
 * module reads and writes that grammar in full, so every adapter can share one
 * implementation and each element flows through the ordinary scalar codec.
 *
 * Vendored rather than taken from `postgres-array` on purpose:
 *   - `postgres-array` only reads; the writer below has no upstream to reuse.
 *   - It must be statically analysable for bundlers (see
 *     `private/temporal-sql-dependency-strategy.md`), which plain source is.
 *   - The same code then serves `pg`, `postgres.js`, Drizzle and Prisma
 *     identically, instead of each driver parsing arrays its own way.
 *
 * Behaviour matches `postgres-array` case for case, and is stricter in the one
 * direction that matters: malformed text throws instead of quietly returning a
 * partial array.
 */
import { UnsupportedValueError } from "./shared.js";

/** One parsed element: text, SQL `NULL`, or a nested array (multidimensional). */
export type PgArrayElement = string | null | PgArrayElement[];

/** Characters Postgres treats as whitespace between array tokens. */
const WHITESPACE = new Set([" ", "\t", "\n", "\r", "\v", "\f"]);

/** Characters that end an unquoted element. */
const UNQUOTED_END = new Set([",", "{", "}"]);

function fail(text: string, position: number, why: string): never {
  throw new UnsupportedValueError(
    `Malformed Postgres array literal at position ${position}: ${why}. Value: ${JSON.stringify(text)}`,
  );
}

/**
 * Parse a Postgres array literal into a nested array of element strings.
 *
 * Handles every shape `array_out` can emit and `array_in` can accept:
 *
 * | Input | Result |
 * |---|---|
 * | `{}` | `[]` |
 * | `{a,b}` | `["a", "b"]` |
 * | `{NULL}` | `[null]` — the unquoted token is SQL NULL |
 * | `{"NULL"}` | `["NULL"]` — quoted, so it is the literal text |
 * | `{"a,b"}` | `["a,b"]` — a comma inside quotes is data |
 * | `{"a\"b"}` | `['a"b']` — backslash escapes survive |
 * | `{{1,2},{3,4}}` | `[["1","2"], ["3","4"]]` |
 * | `[0:2]={a,b,c}` | `["a","b","c"]` — the dimension prefix is consumed |
 *
 * @throws {UnsupportedValueError} on unbalanced braces, an unterminated quote,
 *   an empty unquoted element, or trailing text after the closing brace.
 */
export function parsePgArray(text: string): PgArrayElement[] {
  if (typeof text !== "string") {
    // Almost always means the driver already parsed the column: `pg` decodes
    // array OIDs to JS values unless a passthrough parser is registered.
    throw new UnsupportedValueError(
      `Expected Postgres array text but received ${text === null ? "null" : typeof text}. ` +
        "The driver has already parsed this column. With Drizzle, call registerPassthrough() " +
        'from "temporal-sql/pg" once at startup so the raw text reaches the codec.',
    );
  }
  let i = 0;

  const skipWhitespace = (): void => {
    while (i < text.length && WHITESPACE.has(text[i]!)) i++;
  };

  // An array whose lower bound is not 1 is rendered with an explicit dimension
  // prefix, e.g. `[0:2]={a,b,c}` or `[1:2][1:2]={{1,2},{3,4}}`. The bounds carry
  // no information a JS array can hold, so consume through the `=` and drop them.
  const skipDimensions = (): void => {
    skipWhitespace();
    if (text[i] !== "[") return;
    const eq = text.indexOf("=", i);
    if (eq === -1) fail(text, i, "dimension prefix has no '='");
    i = eq + 1;
  };

  /** Read a `"..."` element. Assumes the opening quote is at `i`. */
  const readQuoted = (): string => {
    i++; // opening quote
    let out = "";
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === "\\") {
        if (i + 1 >= text.length) fail(text, i, "trailing backslash");
        out += text[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === '"') {
        i++; // closing quote
        return out;
      }
      out += ch;
      i++;
    }
    return fail(text, i, "unterminated quoted element");
  };

  /**
   * Read a bare element. Postgres only leaves an element unquoted when it is
   * unambiguous, so `NULL` here is always the SQL null — text that happens to
   * read "null" is quoted by `array_out`. Trailing whitespace is dropped, which
   * is what `array_in` does.
   */
  const readUnquoted = (): string | null => {
    const start = i;
    let out = "";
    let escaped = false;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === "\\") {
        if (i + 1 >= text.length) fail(text, i, "trailing backslash");
        out += text[i + 1]!;
        i += 2;
        escaped = true;
        continue;
      }
      if (ch === '"') fail(text, i, "unexpected quote inside an unquoted element");
      if (UNQUOTED_END.has(ch)) break;
      out += ch;
      i++;
    }
    const trimmed = out.replace(/[ \t\n\r\v\f]+$/, "");
    if (trimmed.length === 0) fail(text, start, "empty element (expected a value)");
    // An escape means the writer spelled the characters out deliberately, so
    // `\NULL` is the four-letter text, not SQL NULL — same rule `array_in` uses.
    return !escaped && trimmed.toLowerCase() === "null" ? null : trimmed;
  };

  /** Read a `{...}` array. Assumes the opening brace is at `i`. */
  const readArray = (): PgArrayElement[] => {
    i++; // opening brace
    const out: PgArrayElement[] = [];

    skipWhitespace();
    if (text[i] === "}") {
      i++;
      return out; // `{}` — the empty array
    }

    for (;;) {
      skipWhitespace();
      const ch = text[i];
      if (ch === undefined) fail(text, i, "unexpected end of input (unbalanced '{')");
      if (ch === "{") out.push(readArray());
      else if (ch === '"') out.push(readQuoted());
      else if (ch === "}") fail(text, i, "empty element before '}'");
      else out.push(readUnquoted());

      skipWhitespace();
      const next = text[i];
      if (next === ",") {
        i++;
        continue;
      }
      if (next === "}") {
        i++;
        return out;
      }
      if (next === undefined) fail(text, i, "unexpected end of input (unbalanced '{')");
      fail(text, i, `expected ',' or '}' but found ${JSON.stringify(next)}`);
    }
  };

  skipDimensions();
  skipWhitespace();
  if (text[i] !== "{") fail(text, i, "expected '{'");
  const result = readArray();
  skipWhitespace();
  if (i !== text.length) fail(text, i, "unexpected text after the closing '}'");
  return result;
}

/**
 * Render a nested array of element strings as a Postgres array literal.
 *
 * Every non-null element is quoted and its `"` and `\` escaped. Postgres accepts
 * a quoted element anywhere a bare one is allowed, so quoting unconditionally
 * removes the need to reason about which characters would have forced it —
 * including the case where an element's text is literally `NULL`.
 */
export function formatPgArray(items: readonly PgArrayElement[]): string {
  const parts = items.map((item) => {
    if (item === null) return "NULL";
    if (Array.isArray(item)) return formatPgArray(item);
    return `"${item.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  });
  return `{${parts.join(",")}}`;
}

/**
 * Decode a one-dimensional array literal, running every non-null element through
 * `decode`. This is the entry point every driver adapter uses.
 *
 * Nulls survive as `null` — a Postgres array really can hold them, so the result
 * is `(T | null)[]` rather than `T[]`.
 *
 * @throws {UnsupportedValueError} if the literal is multidimensional. The nesting
 *   is parsed correctly by {@link parsePgArray}, but there is no single Temporal
 *   value for a nested element, so this reports the limitation instead of
 *   mis-mapping it. Use `parsePgArray` directly to handle nesting yourself.
 */
export function decodePgArray<T>(text: string, decode: (element: string) => T): (T | null)[] {
  return parsePgArray(text).map((element) => {
    if (element === null) return null;
    if (Array.isArray(element)) {
      throw new UnsupportedValueError(
        "Multidimensional Postgres arrays are not supported by the Temporal array codecs. " +
          "Read the column as text and use parsePgArray() to walk the nesting yourself.",
      );
    }
    return decode(element);
  });
}

/**
 * Encode a one-dimensional array of Temporal values as a Postgres array literal,
 * running every non-null value through `encode`.
 *
 * Errors from `encode` (notably `PrecisionError` on a sub-microsecond value)
 * propagate and abort the whole array — the same all-or-nothing contract the
 * scalar encoders already have.
 */
export function encodePgArray<T>(
  values: readonly (T | null | undefined)[],
  encode: (value: T) => string,
): string {
  return formatPgArray(values.map((value) => (value === null || value === undefined ? null : encode(value))));
}
