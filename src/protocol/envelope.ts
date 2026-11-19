// The messages the host and the extension exchange on the native-messaging
// port, which carries several clients' requests at once. Chrome hands each
// message over already decoded, so these validate values, not lines.

import {
  anything,
  type Check,
  describe,
  fail,
  isJsonObject,
  type JsonObject,
  literal,
  mapError,
  object,
  oneOf,
  own,
  quote,
  string,
  succeed,
} from "./check.ts";
import { type ErrorCode, PROTOCOL_VERSION, REFUSALS } from "./constants.ts";
import { validateRequest } from "./request.ts";
import { failure, validateResponse } from "./response.ts";
import type {
  EnvelopeFault,
  Hello,
  HostMessage,
  ResponseEnvelope,
  Result,
} from "./types.ts";

const fault = (
  id: string | null,
  code: ErrorCode,
  message: string,
): { readonly ok: false; readonly error: EnvelopeFault } =>
  fail({ id, failure: failure(code, message) });

const id: Check<string> = (value, path) => {
  const checked = string(value, path);
  return checked.ok && checked.value === ""
    ? fail(`field ${quote(path)} must not be empty`)
    : checked;
};

/** The envelope's `id`, when it has a valid one. */
const idOf = (value: JsonObject): string | null => {
  const checked = id(own(value, "id"), "id");
  return checked.ok ? checked.value : null;
};

const helloBody: Check<Hello["hello"]> = (value, path) =>
  isJsonObject(value) && Object.hasOwn(value, "refused")
    ? object({ refused: oneOf(REFUSALS) })(value, path)
    : object({ protocol: literal(PROTOCOL_VERSION) })(value, path);

const helloShape: Check<Hello> = object({ hello: helloBody });

const validateHello = (value: JsonObject): Result<Hello, EnvelopeFault> => {
  const body = own(value, "hello");
  if (
    isJsonObject(body) &&
    Object.hasOwn(body, "protocol") &&
    own(body, "protocol") !== PROTOCOL_VERSION
  ) {
    return fault(
      null,
      "unsupported-protocol",
      `the host's protocol is ${describe(own(body, "protocol"))}; this extension speaks protocol ${PROTOCOL_VERSION}`,
    );
  }
  return mapError(helloShape(value, ""), (message) => ({
    id: null,
    failure: failure("internal", `malformed hello: ${message}`),
  }));
};

const requestEnvelopeShape = object({ id, request: anything });

const responseEnvelopeShape = object({ id, response: anything });

/**
 * Validates a message from the host: its hello, or a request envelope. A
 * request envelope with a valid `id` and an invalid request fails with the
 * request's own failure and that `id`, so the extension can answer it.
 */
export const validateHostMessage = (
  value: unknown,
): Result<HostMessage, EnvelopeFault> => {
  if (!isJsonObject(value)) {
    return fault(null, "internal", "a native message must be a JSON object");
  }
  if (Object.hasOwn(value, "hello")) {
    return validateHello(value);
  }
  const shape = requestEnvelopeShape(value, "");
  if (!shape.ok) {
    return fault(idOf(value), "internal", `malformed envelope: ${shape.error}`);
  }
  const request = validateRequest(shape.value.request);
  return request.ok
    ? succeed({ id: shape.value.id, request: request.value })
    : fail({ id: shape.value.id, failure: request.error });
};

/**
 * Validates a message from the extension: a response envelope. A fault in
 * an envelope with a valid `id` keeps that `id`, so the host can answer
 * the client that sent the request.
 */
export const validateExtensionMessage = (
  value: unknown,
): Result<ResponseEnvelope, EnvelopeFault> => {
  if (!isJsonObject(value)) {
    return fault(null, "internal", "a native message must be a JSON object");
  }
  const shape = responseEnvelopeShape(value, "");
  if (!shape.ok) {
    return fault(idOf(value), "internal", `malformed envelope: ${shape.error}`);
  }
  const response = validateResponse(shape.value.response);
  return response.ok
    ? succeed({ id: shape.value.id, response: response.value })
    : fail({ id: shape.value.id, failure: response.error });
};
