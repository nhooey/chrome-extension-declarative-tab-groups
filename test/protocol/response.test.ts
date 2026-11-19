import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ERROR_CODES,
  encode,
  failure,
  parseResponse,
  type Response,
} from "../../src/protocol/index.ts";

const responses: readonly Response[] = [
  {
    protocol: 1,
    ok: true,
    command: "set",
    group: { title: "Reading", windowId: 12, created: true },
    opened: 2,
    closed: 0,
    kept: [{ url: "https://example.org/compose", title: "Draft" }],
    unchecked: 0,
    loading: 1,
  },
  {
    protocol: 1,
    ok: true,
    command: "get",
    group: { title: "Reading", windowId: 12 },
    tabs: [{ url: "https://example.com/", title: "Line\nbreak" }],
  },
  {
    protocol: 1,
    ok: true,
    command: "status",
    extension: "0.1.0",
    chrome: "142.0.7444.176",
  },
  ...ERROR_CODES.map((code) => failure(code, `a ${code} failure`)),
];

const malformed = (response: object, message: string): void =>
  assert.deepEqual(parseResponse(JSON.stringify(response)), {
    ok: false,
    error: failure("internal", `malformed response: ${message}`),
  });

describe("parseResponse", () => {
  it("round-trips every response kind and every error code through encode", () => {
    responses.forEach((response) =>
      assert.deepEqual(parseResponse(encode(response)), {
        ok: true,
        value: response,
      }),
    );
  });

  it("writes each response as one line, ended by one newline", () => {
    responses.forEach((response) => {
      const line = encode(response);
      assert.equal(line.indexOf("\n"), line.length - 1);
    });
  });

  it("rejects a value that is not one object, including null", () => {
    ["null", "[]", "1", '"x"', "true"].forEach((line) =>
      assert.deepEqual(parseResponse(line), {
        ok: false,
        error: failure(
          "internal",
          "malformed response: a response must be one JSON object",
        ),
      }),
    );
  });

  it("answers a deeply nested protocol with a result, never a throw", () => {
    const deep = `${"[".repeat(100_000)}${"]".repeat(100_000)}`;
    assert.deepEqual(parseResponse(`{"protocol":${deep}}`), {
      ok: false,
      error: failure(
        "unsupported-protocol",
        "the response's protocol is an array; this client speaks protocol 1",
      ),
    });
  });

  it("rejects a negative window ID", () => {
    malformed(
      { ...responses[1], group: { title: "Reading", windowId: -1 } },
      'field "group.windowId" must be a whole number of 0 or more',
    );
  });

  it("rejects a line that is not JSON", () => {
    assert.deepEqual(parseResponse("{"), {
      ok: false,
      error: failure(
        "internal",
        "malformed response: the line is not valid JSON",
      ),
    });
  });

  it("rejects another protocol as unsupported-protocol", () => {
    assert.deepEqual(parseResponse('{"protocol":2,"ok":true}'), {
      ok: false,
      error: failure(
        "unsupported-protocol",
        "the response's protocol is 2; this client speaks protocol 1",
      ),
    });
  });

  it("rejects a response without ok", () => {
    malformed({ protocol: 1 }, 'field "ok" must be true or false');
  });

  it("rejects an unknown error code", () => {
    malformed(
      { protocol: 1, ok: false, error: { code: "oops", message: "m" } },
      `field "error.code" must be one of ${ERROR_CODES.join(", ")}`,
    );
  });

  it("rejects a negative count", () => {
    malformed(
      { ...responses[0], closed: -1 },
      'field "closed" must be a whole number of 0 or more',
    );
  });

  it("rejects a malformed kept tab, naming it", () => {
    malformed(
      { ...responses[0], kept: [{ url: "https://example.org/" }] },
      'missing field "kept[0].title"',
    );
  });

  it("rejects an unknown field", () => {
    malformed({ ...responses[2], focused: false }, 'unknown field "focused"');
  });
});
