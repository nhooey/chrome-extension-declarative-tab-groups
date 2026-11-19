import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type ErrorCode,
  failure,
  validateExtensionMessage,
  validateHostMessage,
} from "../../src/protocol/index.ts";

const faults = (
  result: unknown,
  id: string | null,
  code: ErrorCode,
  message: string,
): void =>
  assert.deepEqual(result, {
    ok: false,
    error: { id, failure: failure(code, message) },
  });

const accepted = (value: unknown) => ({ ok: true, value });

describe("validateHostMessage: hello", () => {
  it("accepts the hello that serves, and both refusals", () => {
    [
      { hello: { protocol: 1 } },
      { hello: { refused: "not-google-chrome" } },
      { hello: { refused: "socket-in-use" } },
    ].forEach((hello) =>
      assert.deepEqual(validateHostMessage(hello), accepted(hello)),
    );
  });

  it("rejects a hello of another protocol as unsupported-protocol", () => {
    faults(
      validateHostMessage({ hello: { protocol: 2 } }),
      null,
      "unsupported-protocol",
      "the host's protocol is 2; this extension speaks protocol 1",
    );
  });

  it("answers deeply nested values with a result, never a throw", () => {
    const nested = (json: string): unknown =>
      JSON.parse(
        json.replace("DEEP", `${"[".repeat(100_000)}${"]".repeat(100_000)}`),
      );
    faults(
      validateHostMessage(nested('{"hello":{"protocol":DEEP}}')),
      null,
      "unsupported-protocol",
      "the host's protocol is an array; this extension speaks protocol 1",
    );
    faults(
      validateHostMessage(nested('{"id":"7","request":{"protocol":DEEP}}')),
      "7",
      "unsupported-protocol",
      "the request's protocol is an array; this host speaks protocol 1",
    );
    faults(
      validateExtensionMessage(
        nested('{"id":"7","response":{"protocol":DEEP}}'),
      ),
      "7",
      "unsupported-protocol",
      "the response's protocol is an array; this client speaks protocol 1",
    );
  });

  it("rejects null and other values that are not an object", () => {
    [null, [], 1, "x", true].forEach((value) => {
      faults(
        validateHostMessage(value),
        null,
        "internal",
        "a native message must be a JSON object",
      );
      faults(
        validateExtensionMessage(value),
        null,
        "internal",
        "a native message must be a JSON object",
      );
    });
  });

  it("rejects an unknown refusal", () => {
    faults(
      validateHostMessage({ hello: { refused: "tired" } }),
      null,
      "internal",
      'malformed hello: field "hello.refused" must be one of not-google-chrome, socket-in-use',
    );
  });

  it("rejects a hello with another field", () => {
    faults(
      validateHostMessage({ hello: { protocol: 1 }, id: "1" }),
      null,
      "internal",
      'malformed hello: unknown field "id"',
    );
  });
});

describe("validateHostMessage: request envelope", () => {
  const request = { protocol: 1, command: "get", group: "Reading" };

  it("accepts an envelope with an id and a valid request", () => {
    const envelope = { id: "7", request };
    assert.deepEqual(validateHostMessage(envelope), accepted(envelope));
  });

  it("answers an invalid request under its envelope's id", () => {
    faults(
      validateHostMessage({ id: "7", request: { ...request, protocol: 2 } }),
      "7",
      "unsupported-protocol",
      "the request's protocol is 2; this host speaks protocol 1",
    );
  });

  it("rejects an envelope with an empty id", () => {
    faults(
      validateHostMessage({ id: "", request }),
      null,
      "internal",
      'malformed envelope: field "id" must not be empty',
    );
  });

  it("keeps a valid id when the envelope has another fault", () => {
    faults(
      validateHostMessage({ id: "7" }),
      "7",
      "internal",
      'malformed envelope: missing field "request"',
    );
  });

  it("rejects a message that is not an object", () => {
    faults(
      validateHostMessage("hello"),
      null,
      "internal",
      "a native message must be a JSON object",
    );
  });
});

describe("validateExtensionMessage", () => {
  const response = {
    protocol: 1,
    ok: true,
    command: "status",
    extension: "0.1.0",
    chrome: "142.0.7444.176",
  };

  it("accepts an envelope with an id and a valid response", () => {
    const envelope = { id: "7", response };
    assert.deepEqual(validateExtensionMessage(envelope), accepted(envelope));
  });

  it("reports a malformed response under its envelope's id", () => {
    faults(
      validateExtensionMessage({
        id: "7",
        response: { ...response, chrome: 142 },
      }),
      "7",
      "internal",
      'malformed response: field "chrome" must be a string',
    );
  });

  it("rejects an envelope with an unknown field", () => {
    faults(
      validateExtensionMessage({ id: "7", response, extra: 1 }),
      "7",
      "internal",
      'malformed envelope: unknown field "extra"',
    );
  });
});
