// Checks of decoded JSON values, each naming the faulty field in its message.

import { URL_PREFIXES } from "./constants.ts";
import type { Result } from "./types.ts";

/** Checks one JSON value found at `path`, such as `urls[2]` or `group.title`. */
export type Check<T> = (value: unknown, path: string) => Result<T, string>;

export type JsonObject = { readonly [key: string]: unknown };

export const succeed = <T>(
  value: T,
): { readonly ok: true; readonly value: T } => ({
  ok: true,
  value,
});

export const fail = <E>(
  error: E,
): { readonly ok: false; readonly error: E } => ({
  ok: false,
  error,
});

export const mapError = <T, E, F>(
  result: Result<T, E>,
  f: (error: E) => F,
): Result<T, F> => (result.ok ? result : fail(f(result.error)));

export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The object's own property `key`, never one it inherits. */
export const own = (value: JsonObject, key: string): unknown =>
  Object.hasOwn(value, key) ? value[key] : undefined;

const MAX_QUOTED_LENGTH = 64;

/** A string from a client, quoted for a message and cut to a short length. */
export const quote = (text: string): string =>
  JSON.stringify(
    text.length > MAX_QUOTED_LENGTH
      ? `${text.slice(0, MAX_QUOTED_LENGTH)}…`
      : text,
  );

/**
 * A client's value, described for a message: a primitive as itself, a
 * string quoted and cut short, and an array or an object only by its kind,
 * so a deeply nested value is never serialised.
 */
export const describe = (value: unknown): string =>
  typeof value === "string"
    ? quote(value)
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : value === null
        ? "null"
        : value === undefined
          ? "missing"
          : Array.isArray(value)
            ? "an array"
            : "an object";

const field = (path: string, key: string): string =>
  path === "" ? key : `${path}.${key}`;

const includes = <T extends string>(
  options: readonly T[],
  value: string,
): value is T => (options as readonly string[]).includes(value);

/** A control character: U+0000 to U+001F, or U+007F. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A control character or a space: U+0000 to U+0020, or U+007F. */
const CONTROL_OR_SPACE = /[\u0000- \u007f]/;

/** The text with only the ASCII letters A to Z lowered. */
const asciiLowerCase = (text: string): string =>
  Array.from(text)
    .map((character) =>
      character >= "A" && character <= "Z"
        ? String.fromCharCode(character.charCodeAt(0) + 32)
        : character,
    )
    .join("");

const failed = <T>(
  result: Result<T, string>,
): result is { readonly ok: false; readonly error: string } => !result.ok;

export const anything: Check<unknown> = (value) => succeed(value);

export const string: Check<string> = (value, path) =>
  typeof value === "string"
    ? succeed(value)
    : fail(`field ${quote(path)} must be a string`);

/**
 * A title: a string that is not empty after trimming and holds no control
 * character (U+0000 to U+001F, or U+007F); it is kept as given.
 */
export const title: Check<string> = (value, path) =>
  typeof value !== "string"
    ? fail(`field ${quote(path)} must be a string`)
    : value.trim() === ""
      ? fail(`field ${quote(path)} must not be empty or only whitespace`)
      : CONTROL.test(value)
        ? fail(`field ${quote(path)} must not hold a control character`)
        : succeed(value);

export const boolean: Check<boolean> = (value, path) =>
  typeof value === "boolean"
    ? succeed(value)
    : fail(`field ${quote(path)} must be true or false`);

/** A whole number of 0 or more, such as a count or a Chrome window ID. */
export const count: Check<number> = (value, path) =>
  Number.isSafeInteger(value) && (value as number) >= 0
    ? succeed(value as number)
    : fail(`field ${quote(path)} must be a whole number of 0 or more`);

export const literal =
  <const T extends string | number | boolean>(expected: T): Check<T> =>
  (value, path) =>
    value === expected
      ? succeed(expected)
      : fail(`field ${quote(path)} must be ${JSON.stringify(expected)}`);

export const oneOf =
  <const T extends string>(options: readonly T[]): Check<T> =>
  (value, path) =>
    typeof value === "string" && includes(options, value)
      ? succeed(value)
      : fail(`field ${quote(path)} must be one of ${options.join(", ")}`);

/**
 * A URL kept as given: it holds no character at or below U+0020, no U+007F
 * and no backslash, begins with one of `URL_PREFIXES` in any ASCII case,
 * and parses. The text checks come first because `URL` forgives what they
 * reject, such as surrounding spaces, a newline or `https:\\host`. `URL` is
 * the WHATWG global that both Node and a service worker have.
 */
export const url: Check<string> = (value, path) =>
  typeof value !== "string"
    ? fail(`field ${quote(path)} must be a string`)
    : CONTROL_OR_SPACE.test(value)
      ? fail(`field ${quote(path)} must not hold a space or control character`)
      : value.includes("\\")
        ? fail(`field ${quote(path)} must not hold a backslash`)
        : !URL_PREFIXES.some(
              (prefix) =>
                asciiLowerCase(value.slice(0, prefix.length)) === prefix,
            )
          ? fail(
              `field ${quote(path)} must begin with ${URL_PREFIXES.join(", ")}`,
            )
          : URL.parse(value) === null
            ? fail(`field ${quote(path)} must be a URL`)
            : succeed(value);

export const arrayOf =
  <T>(item: Check<T>): Check<readonly T[]> =>
  (value, path) => {
    if (!Array.isArray(value)) {
      return fail(`field ${quote(path)} must be an array`);
    }
    const check = (element: unknown, index: number): Result<T, string> =>
      item(element, `${path}[${index}]`);
    // Stops at the first faulty element, so a long bad array builds no
    // list of messages; only a valid array is checked a second time, to
    // collect its values.
    const faulty = value.findIndex(
      (element: unknown, index) => !check(element, index).ok,
    );
    if (faulty !== -1) {
      const result = check(value[faulty], faulty);
      return result.ok ? succeed([result.value]) : result;
    }
    return succeed(
      value.flatMap((element: unknown, index) => {
        const result = check(element, index);
        return result.ok ? [result.value] : [];
      }),
    );
  };

type Shape = { readonly [key: string]: Check<unknown> };

type Checked<S extends Shape> = {
  readonly [K in keyof S]: S[K] extends Check<infer T> ? T : never;
};

export type Shaped<R extends Shape, O extends Shape> = Checked<R> &
  Partial<Checked<O>>;

/**
 * An object with exactly the `required` fields and any of the `optional`
 * ones. Faults are reported in this order: an unknown field, a missing
 * field, then each field's own check in the order the shapes list them.
 * Every lookup is of own properties, so `__proto__` or `toString` is an
 * unknown field like any other.
 */
export const object =
  <R extends Shape, O extends Shape = Record<never, never>>(
    required: R,
    optional?: O,
  ): Check<Shaped<R, O>> =>
  (value, path) => {
    if (!isJsonObject(value)) {
      return fail(`field ${quote(path)} must be a JSON object`);
    }
    const optionalShape: Shape = optional ?? {};
    const unknownKey = Object.keys(value).find(
      (key) =>
        !Object.hasOwn(required, key) && !Object.hasOwn(optionalShape, key),
    );
    if (unknownKey !== undefined) {
      return fail(`unknown field ${quote(field(path, unknownKey))}`);
    }
    const missingKey = Object.keys(required).find(
      (key) => !Object.hasOwn(value, key),
    );
    if (missingKey !== undefined) {
      return fail(`missing field ${quote(field(path, missingKey))}`);
    }
    const checks = [
      ...Object.entries(required),
      ...Object.entries(optionalShape).filter(([key]) =>
        Object.hasOwn(value, key),
      ),
    ];
    const results = checks.map(
      ([key, check]) =>
        [key, check(own(value, key), field(path, key))] as const,
    );
    const firstFailure = results.map(([, result]) => result).find(failed);
    return firstFailure !== undefined
      ? firstFailure
      : succeed(
          Object.fromEntries(
            results.flatMap(([key, result]) =>
              result.ok ? [[key, result.value]] : [],
            ),
          ) as Shaped<R, O>,
        );
  };
