// The socket's line format: one JSON object per line, each way.

import { fail, succeed } from "./check.ts";
import { MAX_REQUEST_LINE_BYTES } from "./constants.ts";
import { validateRequest } from "./request.ts";
import { failure, validateResponse } from "./response.ts";
import type { Request, Response, Result } from "./types.ts";

/**
 * Whether the text's UTF-8 encoding is longer than `limit` bytes. A UTF-16
 * code unit takes 1 to 3 bytes, and a surrogate pair 4, so most lines are
 * settled by their length alone. Otherwise the text is encoded into a
 * buffer one byte over the limit: it is too long when it does not all fit,
 * or fills that last byte. `TextEncoder` is the WHATWG global that both Node
 * and a service worker have.
 */
const longerThan = (text: string, limit: number): boolean => {
  if (text.length > limit) {
    return true;
  }
  if (text.length * 3 <= limit) {
    return false;
  }
  const { read, written } = new TextEncoder().encodeInto(
    text,
    new Uint8Array(limit + 1),
  );
  return read < text.length || written > limit;
};

const parseJson = (line: string): Result<unknown, null> => {
  try {
    return succeed(JSON.parse(line) as unknown);
  } catch {
    return fail(null);
  }
};

/**
 * Parses one request line, without its `\n`; a bad line gives the failure
 * response to send back. A line over `MAX_REQUEST_LINE_BYTES` is rejected
 * before it is parsed.
 */
export const parseRequest = (line: string): Result<Request> => {
  if (longerThan(line, MAX_REQUEST_LINE_BYTES)) {
    return fail(
      failure(
        "invalid-request",
        `the request line is longer than ${MAX_REQUEST_LINE_BYTES} bytes`,
      ),
    );
  }
  const json = parseJson(line);
  return json.ok
    ? validateRequest(json.value)
    : fail(failure("invalid-request", "the request line is not valid JSON"));
};

/** Parses one response line, as a client reads it. */
export const parseResponse = (line: string): Result<Response> => {
  const json = parseJson(line);
  return json.ok
    ? validateResponse(json.value)
    : fail(
        failure("internal", "malformed response: the line is not valid JSON"),
      );
};

/** The message as one line: its JSON text, which holds no raw newline, then `\n`. */
export const encode = (message: Request | Response): string =>
  `${JSON.stringify(message)}\n`;
