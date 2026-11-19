// The protocol the extension, the host and the command share; see
// docs/protocol.md. Pure: no I/O, and no Node or Chrome API.

export {
  COLORS,
  COMMANDS,
  ERROR_CODES,
  MAX_REQUEST_LINE_BYTES,
  PROTOCOL_VERSION,
  REFUSALS,
  URL_PREFIXES,
  type Color,
  type Command,
  type ErrorCode,
  type ProtocolVersion,
  type Refusal,
} from "./constants.ts";
export { validateExtensionMessage, validateHostMessage } from "./envelope.ts";
export { encode, parseRequest, parseResponse } from "./line.ts";
export { validateRequest } from "./request.ts";
export { failure, validateResponse } from "./response.ts";
export type {
  EnvelopeFault,
  Failure,
  GetRequest,
  GetSuccess,
  Hello,
  HostMessage,
  Request,
  RequestEnvelope,
  Response,
  ResponseEnvelope,
  Result,
  SetRequest,
  SetSuccess,
  StatusRequest,
  StatusSuccess,
  Success,
  Tab,
} from "./types.ts";
