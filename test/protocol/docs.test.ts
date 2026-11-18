// Holds docs/protocol.md to the code: every fenced `json` example names the
// message it shows in its info string, as in "```json request", and the
// matching parser must accept it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  COLORS,
  COMMANDS,
  ERROR_CODES,
  parseRequest,
  parseResponse,
  type Result,
  validateExtensionMessage,
  validateHostMessage,
} from "../../src/protocol/index.ts";
import { type Fence, fencedBlocks } from "../markdown.ts";

const markdown = readFileSync(
  new URL("../../docs/protocol.md", import.meta.url),
  "utf8",
);

const parseJson = (body: string): unknown => JSON.parse(body);

const parsers: {
  readonly [kind: string]: (body: string) => Result<unknown, unknown>;
} = {
  request: parseRequest,
  response: parseResponse,
  "host-message": (body) => validateHostMessage(parseJson(body)),
  "extension-message": (body) => validateExtensionMessage(parseJson(body)),
};

// Every block that may hold an example: a language starting with "json" in
// any case, or a tilde fence. Each must be "json <kind>", so that none is
// skipped silently.
const examplesIn = (text: string): readonly Fence[] =>
  fencedBlocks(text).filter(
    ({ marker, info }) =>
      (info[0] ?? "").toLowerCase().startsWith("json") || marker[0] === "~",
  );

const namesItsKind = ({ info }: Fence): boolean =>
  info.length === 2 &&
  info[0] === "json" &&
  Object.hasOwn(parsers, info[1] ?? "");

const parserOf = (
  kind: string,
): ((body: string) => Result<unknown, unknown>) | undefined =>
  Object.hasOwn(parsers, kind) ? parsers[kind] : undefined;

const examples = examplesIn(markdown);

const examplesOf = (kind: string): readonly unknown[] =>
  examples
    .filter(({ info }) => info[1] === kind)
    .map(({ body }) => parseJson(body));

describe("docs/protocol.md", () => {
  it("has json examples", () => {
    assert.ok(examples.length > 0);
  });

  it("names the kind of every json example", () => {
    examples.forEach((example) =>
      assert.ok(
        namesItsKind(example),
        `the block at line ${example.line} is not "json" and one of ${Object.keys(parsers).join(", ")}`,
      ),
    );
  });

  it("finds a mistagged json block or a tilde fence, so none is skipped", () => {
    const text = [
      "```JSON",
      "{}",
      "```",
      "~~~~",
      "{}",
      "~~~~",
      "```json constructor",
      "{}",
      "```",
      "```sh",
      "true",
      "```",
    ].join("\n");
    const found = examplesIn(text);
    assert.deepEqual(
      found.map(({ line }) => line),
      [1, 4, 7],
    );
    assert.ok(found.every((example) => !namesItsKind(example)));
  });

  it("holds examples the matching parser accepts", () => {
    examples.forEach(({ info, line, body }) => {
      const parse = parserOf(info[1] ?? "");
      assert.ok(parse !== undefined);
      const result = parse(body);
      assert.ok(
        result.ok,
        `the ${info[1]} example at line ${line} is rejected: ${JSON.stringify(result.ok ? null : result.error)}`,
      );
    });
  });

  it("shows a request and a success response for every command, and a failure", () => {
    const commandsOf = (kind: string): readonly unknown[] =>
      examplesOf(kind).flatMap((example) =>
        typeof example === "object" && example !== null && "command" in example
          ? [example.command]
          : [],
      );
    assert.deepEqual(new Set(commandsOf("request")), new Set(COMMANDS));
    assert.deepEqual(new Set(commandsOf("response")), new Set(COMMANDS));
    assert.ok(
      examplesOf("response").some(
        (example) =>
          typeof example === "object" &&
          example !== null &&
          "ok" in example &&
          example.ok === false,
      ),
    );
  });

  it("shows the envelope both ways and the hello", () => {
    const hostKeys = examplesOf("host-message").map((example) =>
      Object.keys(example as object).join(","),
    );
    assert.ok(hostKeys.includes("hello"));
    assert.ok(hostKeys.includes("id,request"));
    assert.ok(examplesOf("extension-message").length > 0);
  });

  it("describes every error code and every colour", () => {
    [...ERROR_CODES, ...COLORS].forEach((name) =>
      assert.ok(
        markdown.includes(`\`${name}\``),
        `${name} is not in the document`,
      ),
    );
  });
});
