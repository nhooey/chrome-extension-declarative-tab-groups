// The service worker's edge: Chrome's callbacks become the connection's
// events, and the transition's effects become Chrome calls. The port, the
// connection's state and the per-group queue live here, in the closure of
// `startServiceWorker`, and nowhere else. `background.ts` hands it Chrome.
// Before it handles a request, it ends each request a stopped worker left
// under way in the stored progress, which outlives the worker.

import {
  failure,
  type RequestEnvelope,
  type ResponseEnvelope,
} from "../protocol/index.ts";
import { type Brand, isGoogleChrome } from "./browser.ts";
import { handleRequest, queueKey, type Services } from "./commands.ts";
import {
  type ConnectionEvent,
  type ConnectionState,
  type Effect,
  eventFromMessage,
  HELLO_TIMEOUT_MS,
  INITIAL_STATE,
  RECONNECT_ALARM,
  RECONNECT_PERIOD_MINUTES,
  transition,
} from "./connection.ts";
import { NATIVE_HOST_NAME } from "./identity.ts";
import { endInterrupted } from "./progress-store.ts";
import { MAX_WAITING, queueByKey } from "./queue.ts";
import { messageOf, within } from "./tab-strip.ts";

/** How long the worker waits, at its start, to end the requests a stopped worker left under way. */
export const RECOVERY_TIMEOUT_MS = 5_000;

type Listen<T extends unknown[]> = {
  readonly addListener: (listener: (...args: T) => void) => void;
};

/** The members of a `chrome.runtime.Port` the worker uses. */
export type NativePort = {
  readonly postMessage: (message: ResponseEnvelope) => void;
  readonly disconnect: () => void;
  readonly onMessage: Listen<[message: unknown]>;
  readonly onDisconnect: Listen<[]>;
};

/** What the service worker needs of Chrome besides the tab strip. */
export type WorkerRuntime = {
  /** `navigator.userAgentData.brands`, undefined when the browser has none. */
  readonly brands: readonly Brand[] | undefined;
  readonly connectNative: (application: string) => NativePort;
  /** `chrome.runtime.lastError`'s message, read inside a disconnect listener. */
  readonly lastError: () => string | null;
  readonly onStartup: Listen<[]>;
  readonly onInstalled: Listen<[]>;
  readonly alarms: {
    readonly create: (
      name: string,
      info: { periodInMinutes: number },
    ) => Promise<void>;
    readonly clear: (name: string) => Promise<boolean>;
    readonly onAlarm: Listen<[alarm: { readonly name: string }]>;
  };
  readonly log: (message: string) => void;
  readonly services: Services;
};

const post = (port: NativePort | null, envelope: ResponseEnvelope): void => {
  try {
    port?.postMessage(envelope);
  } catch {
    // The port closed while the request ran; its host has gone, and the
    // response has nobody to go to.
  }
};

/**
 * Starts the worker in Google Chrome: listens for Chrome's start, install
 * and the reconnect alarm, and connects to the native host. In any other
 * browser it does nothing at all and returns false.
 */
export const startServiceWorker = (runtime: WorkerRuntime): boolean => {
  if (runtime.brands === undefined || !isGoogleChrome(runtime.brands)) {
    return false;
  }
  let state: ConnectionState = INITIAL_STATE;
  let port: NativePort | null = null;
  const enqueue = queueByKey();
  const { clock, progress } = runtime.services;
  // A request a stopped worker left under way is ended first, so no
  // request's progress is written over; a storage that has not answered
  // within `RECOVERY_TIMEOUT_MS` holds up no request.
  const recovery = new AbortController();
  const recovered = within(
    clock,
    RECOVERY_TIMEOUT_MS,
    endInterrupted(progress, clock.now(), recovery.signal),
    undefined,
  ).finally(() => recovery.abort());

  const answer = (to: NativePort | null, envelope: RequestEnvelope): void => {
    const respond = () => handleRequest(runtime.services, envelope.request);
    const key = queueKey(envelope.request);
    const full = () =>
      failure(
        "busy",
        `${MAX_WAITING} requests already wait for the group ${JSON.stringify(key)}`,
      );
    void recovered
      .then(() => (key === null ? respond() : enqueue(key, respond, full)))
      .then((response) => post(to, { id: envelope.id, response }));
  };

  const connect = (): void => {
    try {
      const opened = runtime.connectNative(NATIVE_HOST_NAME);
      port = opened;
      opened.onMessage.addListener((message) => {
        if (port === opened) {
          dispatch(eventFromMessage(message));
        }
      });
      opened.onDisconnect.addListener(() => {
        if (port === opened) {
          port = null;
          dispatch({ kind: "disconnected", reason: runtime.lastError() });
        }
      });
    } catch (error) {
      port = null;
      dispatch({ kind: "disconnected", reason: messageOf(error) });
    }
  };

  const perform = (effect: Effect): void => {
    switch (effect.kind) {
      case "connect":
        connect();
        return;
      case "start-hello-timer": {
        const waiting = port;
        if (waiting !== null) {
          void runtime.services.clock.sleep(HELLO_TIMEOUT_MS).then(() => {
            if (port === waiting) {
              dispatch({ kind: "hello-timeout" });
            }
          });
        }
        return;
      }
      case "disconnect": {
        const closing = port;
        port = null;
        try {
          closing?.disconnect();
        } catch {
          // Already closed.
        }
        return;
      }
      case "schedule-reconnect":
        void runtime.alarms.create(RECONNECT_ALARM, {
          periodInMinutes: RECONNECT_PERIOD_MINUTES,
        });
        return;
      case "cancel-reconnect":
        void runtime.alarms.clear(RECONNECT_ALARM);
        return;
      case "handle":
        answer(port, effect.envelope);
        return;
      case "post":
        post(port, effect.envelope);
        return;
      case "log":
        runtime.log(effect.message);
        return;
    }
  };

  const dispatch = (event: ConnectionEvent): void => {
    const next = transition(state, event);
    state = next.state;
    next.effects.forEach(perform);
  };

  runtime.onStartup.addListener(() => dispatch({ kind: "start" }));
  runtime.onInstalled.addListener(() => dispatch({ kind: "start" }));
  runtime.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RECONNECT_ALARM) {
      dispatch({ kind: "alarm" });
    }
  });
  dispatch({ kind: "start" });
  return true;
};
