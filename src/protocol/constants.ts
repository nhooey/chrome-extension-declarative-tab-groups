/** The protocol this code speaks; a change that breaks a client raises it. */
export const PROTOCOL_VERSION = 1;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/**
 * The longest request line, in UTF-8 bytes without its newline. It leaves
 * room for the host's envelope under Chrome's cap of 1 MB (1,048,576
 * bytes) on a native message to the extension.
 */
export const MAX_REQUEST_LINE_BYTES = 1_000_000;

export const COMMANDS = ["set", "get", "status"] as const;
export type Command = (typeof COMMANDS)[number];

export const ERROR_CODES = [
  "invalid-request",
  "unsupported-protocol",
  "ambiguous-group",
  "no-group",
  "no-window",
  "busy",
  "not-connected",
  "not-google-chrome",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Chrome's tab group colours, as `chrome.tabGroups.Color` names them. */
export const COLORS = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
] as const;
export type Color = (typeof COLORS)[number];

/** How a URL in `set` may begin, compared in any ASCII case. */
export const URL_PREFIXES = ["http://", "https://", "file://"] as const;

/** Why the host will not serve, in its hello on the native-messaging port. */
export const REFUSALS = ["not-google-chrome", "socket-in-use"] as const;
export type Refusal = (typeof REFUSALS)[number];
