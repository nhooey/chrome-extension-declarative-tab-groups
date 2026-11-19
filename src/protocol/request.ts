import {
  arrayOf,
  boolean,
  type Check,
  describe,
  fail,
  isJsonObject,
  literal,
  mapError,
  object,
  oneOf,
  own,
  title,
  url,
} from "./check.ts";
import {
  COLORS,
  COMMANDS,
  PROTOCOL_VERSION,
  type Command,
} from "./constants.ts";
import { failure } from "./response.ts";
import type { Request, Result } from "./types.ts";

const protocol = literal(PROTOCOL_VERSION);

const requestShapes: {
  readonly [C in Command]: Check<Extract<Request, { command: C }>>;
} = {
  set: object(
    {
      protocol,
      command: literal("set"),
      group: title,
      urls: arrayOf(url),
    },
    { color: oneOf(COLORS), createWindow: boolean, statusPage: boolean },
  ),
  get: object({ protocol, command: literal("get"), group: title }),
  status: object({ protocol, command: literal("status") }),
};

const command = oneOf(COMMANDS);

/**
 * Validates a decoded request. `protocol` is checked before anything else
 * about the object, so a client of another protocol always learns that
 * first; every other fault is `invalid-request`, naming the field.
 */
export const validateRequest = (value: unknown): Result<Request> => {
  if (!isJsonObject(value)) {
    return fail(failure("invalid-request", "request must be one JSON object"));
  }
  if (!Object.hasOwn(value, "protocol")) {
    return fail(
      failure(
        "unsupported-protocol",
        `missing field "protocol"; this host speaks protocol ${PROTOCOL_VERSION}`,
      ),
    );
  }
  if (own(value, "protocol") !== PROTOCOL_VERSION) {
    return fail(
      failure(
        "unsupported-protocol",
        `the request's protocol is ${describe(own(value, "protocol"))}; this host speaks protocol ${PROTOCOL_VERSION}`,
      ),
    );
  }
  if (!Object.hasOwn(value, "command")) {
    return fail(failure("invalid-request", 'missing field "command"'));
  }
  const checkedCommand = command(own(value, "command"), "command");
  if (!checkedCommand.ok) {
    return fail(failure("invalid-request", checkedCommand.error));
  }
  const shape: Check<Request> = requestShapes[checkedCommand.value];
  return mapError(shape(value, ""), (message) =>
    failure("invalid-request", message),
  );
};
