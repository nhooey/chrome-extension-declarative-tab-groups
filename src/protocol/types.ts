import type {
  Color,
  ErrorCode,
  ProtocolVersion,
  Refusal,
} from "./constants.ts";

/** The outcome of a parse or a check: a value, or an error; nothing throws. */
export type Result<T, E = Failure> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export type SetRequest = {
  readonly protocol: ProtocolVersion;
  readonly command: "set";
  readonly group: string;
  readonly urls: readonly string[];
  readonly color?: Color;
  readonly createWindow?: boolean;
  readonly statusPage?: boolean;
};

export type GetRequest = {
  readonly protocol: ProtocolVersion;
  readonly command: "get";
  readonly group: string;
};

export type StatusRequest = {
  readonly protocol: ProtocolVersion;
  readonly command: "status";
};

export type Request = SetRequest | GetRequest | StatusRequest;

export type Failure = {
  readonly protocol: ProtocolVersion;
  readonly ok: false;
  readonly error: { readonly code: ErrorCode; readonly message: string };
};

/** A tab as a response reports it. */
export type Tab = { readonly url: string; readonly title: string };

export type SetSuccess = {
  readonly protocol: ProtocolVersion;
  readonly ok: true;
  readonly command: "set";
  readonly group: {
    readonly title: string;
    readonly windowId: number;
    readonly created: boolean;
  };
  readonly opened: number;
  readonly closed: number;
  /** Tabs left open because they hold an unsubmitted form. */
  readonly kept: readonly Tab[];
  /** Tabs closed without the form check being able to run. */
  readonly unchecked: number;
  /** New tabs still loading when the response was sent. */
  readonly loading: number;
};

export type GetSuccess = {
  readonly protocol: ProtocolVersion;
  readonly ok: true;
  readonly command: "get";
  readonly group: { readonly title: string; readonly windowId: number };
  readonly tabs: readonly Tab[];
};

export type StatusSuccess = {
  readonly protocol: ProtocolVersion;
  readonly ok: true;
  readonly command: "status";
  readonly extension: string;
  readonly chrome: string;
};

export type Success = SetSuccess | GetSuccess | StatusSuccess;

export type Response = Success | Failure;

/** Host to extension on the native-messaging port: one client's request. */
export type RequestEnvelope = {
  readonly id: string;
  readonly request: Request;
};

/** Extension to host on the native-messaging port: the answer to the request with the same `id`. */
export type ResponseEnvelope = {
  readonly id: string;
  readonly response: Response;
};

/** The host's first message on the native-messaging port. */
export type Hello = {
  readonly hello:
    { readonly protocol: ProtocolVersion } | { readonly refused: Refusal };
};

export type HostMessage = Hello | RequestEnvelope;

/**
 * A native message that failed validation: the failure to report, and the
 * envelope's `id` when it had a valid one, so the failure can answer it.
 */
export type EnvelopeFault = {
  readonly id: string | null;
  readonly failure: Failure;
};
