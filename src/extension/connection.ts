// The service worker's link to the native host, as a pure transition:
// the link's state and an event in, the new state and the effects to carry
// out. The worker's edge turns Chrome's callbacks into events and carries
// out the effects; nothing here touches Chrome.
//
// The worker connects when it starts and when Chrome starts or installs
// it, waits up to 10 seconds for the host's hello, then serves requests.
// A lost port, a host that says no hello in time, or one that refuses with
// `socket-in-use`, sets a reconnect alarm that fires every 30 seconds until
// a hello is accepted; a host that refuses with `not-google-chrome` stops
// the worker for good.

import {
  type EnvelopeFault,
  failure,
  type Hello,
  type RequestEnvelope,
  type ResponseEnvelope,
  validateHostMessage,
} from "../protocol/index.ts";

/** The name of the alarm that retries the connection. */
export const RECONNECT_ALARM = "reconnect";
/** How often the alarm fires, in minutes: 30 seconds, the shortest Chrome allows. */
export const RECONNECT_PERIOD_MINUTES = 0.5;
/** How long a new port waits for the host's hello before it is dropped. */
export const HELLO_TIMEOUT_MS = 10_000;

export type ConnectionState =
  /** No port; the reconnect alarm, if set, will open one. */
  | { readonly kind: "disconnected" }
  /** A port is open and the host's hello has not come. */
  | { readonly kind: "connecting" }
  /** The host said hello and serves requests. */
  | { readonly kind: "serving" }
  /** The host refused this browser; the worker does nothing more. */
  | { readonly kind: "stopped" };

export const INITIAL_STATE: ConnectionState = { kind: "disconnected" };

export type ConnectionEvent =
  /** The worker started, or Chrome started or installed the extension. */
  | { readonly kind: "start" }
  | { readonly kind: "alarm" }
  | { readonly kind: "hello"; readonly hello: Hello["hello"] }
  | { readonly kind: "request"; readonly envelope: RequestEnvelope }
  /** A message from the host that failed validation. */
  | { readonly kind: "fault"; readonly fault: EnvelopeFault }
  /** The port closed from the host's side, with Chrome's reason if it gave one. */
  | { readonly kind: "disconnected"; readonly reason: string | null }
  /** `HELLO_TIMEOUT_MS` passed since the current port opened. */
  | { readonly kind: "hello-timeout" };

export type Effect =
  | { readonly kind: "connect" }
  /** Send `hello-timeout` after `HELLO_TIMEOUT_MS`, if the port just opened is still the current one. */
  | { readonly kind: "start-hello-timer" }
  | { readonly kind: "disconnect" }
  | { readonly kind: "schedule-reconnect" }
  | { readonly kind: "cancel-reconnect" }
  /** Answer the request, then post the response on the port it came on. */
  | { readonly kind: "handle"; readonly envelope: RequestEnvelope }
  | { readonly kind: "post"; readonly envelope: ResponseEnvelope }
  | { readonly kind: "log"; readonly message: string };

export type Transition = {
  readonly state: ConnectionState;
  readonly effects: readonly Effect[];
};

const to = (
  state: ConnectionState,
  ...effects: readonly Effect[]
): Transition => ({ state, effects });

const DISCONNECTED: ConnectionState = { kind: "disconnected" };
const CONNECTING: ConnectionState = { kind: "connecting" };
const SERVING: ConnectionState = { kind: "serving" };
const STOPPED: ConnectionState = { kind: "stopped" };

const log = (message: string): Effect => ({ kind: "log", message });

/** Drops the port and tries again from the alarm. */
const retryLater = (message: string): Transition =>
  to(
    DISCONNECTED,
    { kind: "disconnect" },
    { kind: "schedule-reconnect" },
    log(message),
  );

const onHello = (state: ConnectionState, hello: Hello["hello"]): Transition => {
  if (state.kind !== "connecting") {
    return to(state, log("ignored a hello outside a new connection"));
  }
  if ("protocol" in hello) {
    return to(SERVING, { kind: "cancel-reconnect" });
  }
  return hello.refused === "not-google-chrome"
    ? to(
        STOPPED,
        { kind: "disconnect" },
        { kind: "cancel-reconnect" },
        log("the host refused this browser as not Google Chrome; stopping"),
      )
    : retryLater("the host refused: another host serves the socket");
};

const onRequest = (
  state: ConnectionState,
  envelope: RequestEnvelope,
): Transition =>
  state.kind === "serving"
    ? to(state, { kind: "handle", envelope })
    : to(state, {
        kind: "post",
        envelope: {
          id: envelope.id,
          response: failure(
            "internal",
            "the host sent a request before the extension accepted its hello",
          ),
        },
      });

const onFault = (state: ConnectionState, fault: EnvelopeFault): Transition => {
  if (state.kind === "connecting" && fault.id === null) {
    return retryLater(
      `the host's hello is not usable: ${fault.failure.error.message}`,
    );
  }
  return fault.id === null
    ? to(
        state,
        log(
          `a message from the host is not usable: ${fault.failure.error.message}`,
        ),
      )
    : to(state, {
        kind: "post",
        envelope: { id: fault.id, response: fault.failure },
      });
};

/** The event a message from the host is: its hello, a request, or a fault. */
export const eventFromMessage = (message: unknown): ConnectionEvent => {
  const checked = validateHostMessage(message);
  return !checked.ok
    ? { kind: "fault", fault: checked.error }
    : "hello" in checked.value
      ? { kind: "hello", hello: checked.value.hello }
      : { kind: "request", envelope: checked.value };
};

/** The link's next state, and the effects that take it there. */
export const transition = (
  state: ConnectionState,
  event: ConnectionEvent,
): Transition => {
  switch (event.kind) {
    case "start":
    case "alarm":
      return state.kind === "disconnected"
        ? to(CONNECTING, { kind: "connect" }, { kind: "start-hello-timer" })
        : event.kind === "alarm" && state.kind !== "connecting"
          ? to(state, { kind: "cancel-reconnect" })
          : to(state);
    case "hello":
      return onHello(state, event.hello);
    case "request":
      return onRequest(state, event.envelope);
    case "fault":
      return onFault(state, event.fault);
    case "disconnected":
      return state.kind === "connecting" || state.kind === "serving"
        ? to(
            DISCONNECTED,
            { kind: "schedule-reconnect" },
            log(
              `the host's port closed${event.reason === null ? "" : `: ${event.reason}`}`,
            ),
          )
        : to(state);
    case "hello-timeout":
      return state.kind === "connecting"
        ? retryLater(
            `the host sent no hello within ${HELLO_TIMEOUT_MS / 1000} seconds`,
          )
        : to(state);
  }
};
