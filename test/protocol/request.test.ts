import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  COLORS,
  type ErrorCode,
  encode,
  failure,
  MAX_REQUEST_LINE_BYTES,
  parseRequest,
  type Request,
} from "../../src/protocol/index.ts";

const rejects = (line: string, code: ErrorCode, message: string): void =>
  assert.deepEqual(parseRequest(line), {
    ok: false,
    error: failure(code, message),
  });

const accepts = (request: Request): void =>
  assert.deepEqual(parseRequest(JSON.stringify(request)), {
    ok: true,
    value: request,
  });

const set = (fields: object): string =>
  JSON.stringify({
    protocol: 1,
    command: "set",
    group: "Reading",
    urls: ["https://example.com/"],
    ...fields,
  });

/** A JSON array nested 100,000 deep: under the size limit, and too deep to serialise. */
const deep = `${"[".repeat(100_000)}${"]".repeat(100_000)}`;

const URL_PREFIX_RULE = "must begin with http://, https://, file://";

describe("parseRequest: the line", () => {
  it("rejects a line that is not JSON", () => {
    rejects(
      "{protocol: 1}",
      "invalid-request",
      "the request line is not valid JSON",
    );
  });

  it("rejects JSON that is not one object: null, an array, a number, a string, a boolean", () => {
    ["null", "[]", "1", '"x"', "true"].forEach((line) =>
      rejects(line, "invalid-request", "request must be one JSON object"),
    );
  });

  // A get request whose group pads the line to `bytes` UTF-8 bytes, with
  // `character` (1 or 2 bytes) as the padding.
  const getOfBytes = (bytes: number, character: string): string => {
    const frame = '{"protocol":1,"command":"get","group":"x"}';
    const padding = bytes - frame.length;
    const width = new TextEncoder().encode(character).length;
    return frame.replace(
      '"x"',
      `"x${character.repeat(Math.floor(padding / width))}${"a".repeat(padding % width)}"`,
    );
  };

  it("accepts a line of exactly MAX_REQUEST_LINE_BYTES bytes", () => {
    const line = getOfBytes(MAX_REQUEST_LINE_BYTES, "é");
    assert.equal(new TextEncoder().encode(line).length, MAX_REQUEST_LINE_BYTES);
    assert.ok(parseRequest(line).ok);
  });

  it("rejects a line one byte longer, counting UTF-8 bytes", () => {
    const line = getOfBytes(MAX_REQUEST_LINE_BYTES + 1, "é");
    assert.ok(line.length < MAX_REQUEST_LINE_BYTES);
    rejects(
      line,
      "invalid-request",
      `the request line is longer than ${MAX_REQUEST_LINE_BYTES} bytes`,
    );
  });

  it("answers deeply nested values with a result, never a throw", () => {
    rejects(
      `{"protocol":${deep}}`,
      "unsupported-protocol",
      "the request's protocol is an array; this host speaks protocol 1",
    );
    rejects(
      `{"protocol":1,"command":"get","group":${deep}}`,
      "invalid-request",
      'field "group" must be a string',
    );
  });
});

describe("parseRequest: protocol", () => {
  it("rejects a request without protocol", () => {
    rejects(
      '{"command":"status"}',
      "unsupported-protocol",
      'missing field "protocol"; this host speaks protocol 1',
    );
  });

  it("rejects another protocol", () => {
    rejects(
      '{"protocol":2,"command":"status"}',
      "unsupported-protocol",
      "the request's protocol is 2; this host speaks protocol 1",
    );
  });

  it("checks protocol before anything else about the object", () => {
    rejects(
      '{"protocol":"1","command":"nope","extra":true}',
      "unsupported-protocol",
      'the request\'s protocol is "1"; this host speaks protocol 1',
    );
  });
});

describe("parseRequest: command and fields", () => {
  it("rejects a request without command", () => {
    rejects('{"protocol":1}', "invalid-request", 'missing field "command"');
  });

  it("rejects an unknown command, including Object's own property names", () => {
    ["close", "constructor", "__proto__", "toString"].forEach((command) =>
      rejects(
        JSON.stringify({ protocol: 1, command }),
        "invalid-request",
        'field "command" must be one of set, get, status',
      ),
    );
  });

  it("rejects an unknown field, naming it", () => {
    rejects(
      '{"protocol":1,"command":"status","group":"Reading"}',
      "invalid-request",
      'unknown field "group"',
    );
  });

  it("rejects Object's own property names as unknown fields", () => {
    ["constructor", "__proto__", "toString"].forEach((name) =>
      rejects(
        `{"protocol":1,"command":"status","${name}":{}}`,
        "invalid-request",
        `unknown field "${name}"`,
      ),
    );
  });

  it("rejects a missing field, naming it", () => {
    rejects(
      '{"protocol":1,"command":"get"}',
      "invalid-request",
      'missing field "group"',
    );
  });

  it("answers an unknown field before a missing one", () => {
    rejects(
      '{"protocol":1,"command":"get","title":"Reading"}',
      "invalid-request",
      'unknown field "title"',
    );
  });

  it("answers a missing field before a mistyped one", () => {
    rejects(
      '{"protocol":1,"command":"set","group":7}',
      "invalid-request",
      'missing field "urls"',
    );
  });

  it("rejects a mistyped field, naming it", () => {
    rejects(
      set({ createWindow: "yes" }),
      "invalid-request",
      'field "createWindow" must be true or false',
    );
  });

  it("accepts every command with its optional fields", () => {
    accepts({ protocol: 1, command: "status" });
    accepts({ protocol: 1, command: "get", group: "Reading" });
    accepts({
      protocol: 1,
      command: "set",
      group: "Reading",
      urls: ["https://example.com/"],
      color: "blue",
      createWindow: true,
      statusPage: false,
    });
  });
});

describe("parseRequest: group", () => {
  it("rejects a group that is not a string", () => {
    rejects(
      set({ group: 7 }),
      "invalid-request",
      'field "group" must be a string',
    );
  });

  it("rejects a group that is empty after trimming", () => {
    rejects(
      set({ group: " \t" }),
      "invalid-request",
      'field "group" must not be empty or only whitespace',
    );
  });

  it("rejects a group holding a control character", () => {
    ["Line\nbreak", "Bell\u0007", "Delete\u007f"].forEach((group) =>
      rejects(
        set({ group }),
        "invalid-request",
        'field "group" must not hold a control character',
      ),
    );
  });

  it("keeps the group exactly as given", () => {
    accepts({ protocol: 1, command: "get", group: "  Reading " });
  });
});

describe("parseRequest: urls", () => {
  const rejectsUrl = (url: string, rule: string): void =>
    rejects(
      set({ urls: ["https://example.com/", url] }),
      "invalid-request",
      `field "urls[1]" ${rule}`,
    );

  it("rejects urls that is not an array", () => {
    rejects(
      set({ urls: "https://example.com/" }),
      "invalid-request",
      'field "urls" must be an array',
    );
  });

  it("rejects an entry that is not a string", () => {
    rejectsUrl(3 as unknown as string, "must be a string");
  });

  it("rejects a space or control character anywhere, which URL would strip", () => {
    [
      " https://example.com/",
      "https://example.com/ ",
      "https://exa\nmple.com/",
      "https://exa\tmple.com/",
      "\u0000http://x",
      "https://example.com/\u007f",
    ].forEach((url) =>
      rejectsUrl(url, "must not hold a space or control character"),
    );
  });

  it("rejects a backslash", () => {
    rejectsUrl("https:\\\\example.com/", "must not hold a backslash");
  });

  it("rejects a URL that does not begin with http://, https:// or file://", () => {
    [
      "http:example.com",
      "example.com/page",
      "javascript:alert(1)",
      "ftp://example.com/",
    ].forEach((url) => rejectsUrl(url, URL_PREFIX_RULE));
  });

  it("rejects a URL that does not parse", () => {
    rejectsUrl("http://", "must be a URL");
  });

  it("accepts an empty list, and http, https and file URLs in any case, as given", () => {
    accepts({ protocol: 1, command: "set", group: "Reading", urls: [] });
    accepts({
      protocol: 1,
      command: "set",
      group: "Reading",
      urls: [
        "http://example.com",
        "HTTPS://example.com/a?b#c",
        "file:///tmp/x.html",
      ],
    });
  });
});

describe("parseRequest: color", () => {
  it("rejects a colour Chrome does not have", () => {
    rejects(
      set({ color: "violet" }),
      "invalid-request",
      `field "color" must be one of ${COLORS.join(", ")}`,
    );
  });

  it("accepts each of Chrome's colours", () => {
    COLORS.forEach((color) =>
      accepts({
        protocol: 1,
        command: "set",
        group: "Reading",
        urls: [],
        color,
      }),
    );
  });
});

describe("encode", () => {
  const requests: readonly Request[] = [
    {
      protocol: 1,
      command: "set",
      group: 'Quote " and \\ backslash, é',
      urls: ["https://example.com/"],
      color: "cyan",
      createWindow: false,
      statusPage: true,
    },
    { protocol: 1, command: "get", group: "Reading" },
    { protocol: 1, command: "status" },
  ];

  it("writes one line, ended by one newline", () => {
    requests.forEach((request) => {
      const line = encode(request);
      assert.equal(line.indexOf("\n"), line.length - 1);
    });
  });

  it("round-trips every request kind through parseRequest", () => {
    requests.forEach((request) =>
      assert.deepEqual(parseRequest(encode(request)), {
        ok: true,
        value: request,
      }),
    );
  });
});
