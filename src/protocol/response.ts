import {
  arrayOf,
  boolean,
  type Check,
  count,
  describe,
  fail,
  isJsonObject,
  literal,
  mapError,
  object,
  oneOf,
  own,
  string,
} from "./check.ts";
import {
  COMMANDS,
  type Command,
  ERROR_CODES,
  type ErrorCode,
  PROTOCOL_VERSION,
} from "./constants.ts";
import type { Failure, Response, Result, Success } from "./types.ts";

/** The failure response with this code and message. */
export const failure = (code: ErrorCode, message: string): Failure => ({
  protocol: PROTOCOL_VERSION,
  ok: false,
  error: { code, message },
});

const protocol = literal(PROTOCOL_VERSION);

const tab = object({ url: string, title: string });

const failureShape: Check<Failure> = object({
  protocol,
  ok: literal(false),
  error: object({ code: oneOf(ERROR_CODES), message: string }),
});

const successShapes: {
  readonly [C in Command]: Check<Extract<Success, { command: C }>>;
} = {
  set: object({
    protocol,
    ok: literal(true),
    command: literal("set"),
    group: object({ title: string, windowId: count, created: boolean }),
    opened: count,
    closed: count,
    kept: arrayOf(tab),
    unchecked: count,
    loading: count,
  }),
  get: object({
    protocol,
    ok: literal(true),
    command: literal("get"),
    group: object({ title: string, windowId: count }),
    tabs: arrayOf(tab),
  }),
  status: object({
    protocol,
    ok: literal(true),
    command: literal("status"),
    extension: string,
    chrome: string,
  }),
};

const command = oneOf(COMMANDS);

const malformed = (message: string): Failure =>
  failure("internal", `malformed response: ${message}`);

/**
 * Validates a decoded response, as the command reads it. A response of
 * another protocol is `unsupported-protocol`; any other fault is
 * `internal`, since the tool's own parts sent it.
 */
export const validateResponse = (value: unknown): Result<Response> => {
  if (!isJsonObject(value)) {
    return fail(malformed("a response must be one JSON object"));
  }
  if (own(value, "protocol") !== PROTOCOL_VERSION) {
    return fail(
      failure(
        "unsupported-protocol",
        `the response's protocol is ${describe(own(value, "protocol"))}; this client speaks protocol ${PROTOCOL_VERSION}`,
      ),
    );
  }
  const ok = boolean(own(value, "ok"), "ok");
  if (!ok.ok) {
    return fail(malformed(ok.error));
  }
  if (!ok.value) {
    return mapError(failureShape(value, ""), malformed);
  }
  const checkedCommand = command(own(value, "command"), "command");
  if (!checkedCommand.ok) {
    return fail(malformed(checkedCommand.error));
  }
  const shape: Check<Success> = successShapes[checkedCommand.value];
  return mapError(shape(value, ""), malformed);
};
