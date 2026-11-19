// The host's routing between the socket's clients and the native-messaging
// port, as a pure transition: the state and an event in, the new state and
// the effects to carry out. `host.ts` turns sockets, standard input and
// timers into events and carries out the effects; nothing here does I/O.
//
// Each connection's responses go back in the order it sent its requests,
// however the extension orders its answers: a connection holds a queue of
// slots, one per request, and a slot's line is written only once every
// slot before it has been.

import {
  encode,
  failure,
  MAX_REQUEST_LINE_BYTES,
  parseRequest,
  type RequestEnvelope,
  type Response,
  validateExtensionMessage,
} from "../protocol/index.ts";
import {
  finishLines,
  INITIAL_LINE_STATE,
  type LineState,
  splitLines,
} from "./lines.ts";

/** How long a request may wait for the extension's answer: 120 seconds. */
export const REQUEST_TIMEOUT_MS = 120_000;

/** A connection's number, which the edge gives it when it connects. */
export type ClientId = number;

/** A request's place in its connection's queue of responses. */
type Slot =
  | { readonly kind: "waiting"; readonly id: string }
  | { readonly kind: "ready"; readonly line: string };

type Client = {
  readonly lines: LineState;
  readonly queue: readonly Slot[];
  /** No more requests are read; the connection closes once its queue is written. */
  readonly closing: boolean;
};

export type RouterState = {
  /** The number the next request's `id` is made from. */
  readonly nextId: number;
  readonly clients: ReadonlyMap<ClientId, Client>;
  /** Each request the extension has not answered, by `id`: the client that sent it. */
  readonly pending: ReadonlyMap<string, ClientId>;
  /** The port closed; the host is ending. */
  readonly stopped: boolean;
};

export const INITIAL_ROUTER_STATE: RouterState = {
  nextId: 1,
  clients: new Map(),
  pending: new Map(),
  stopped: false,
};

export type RouterEvent =
  | { readonly kind: "client-connected"; readonly client: ClientId }
  /** Bytes from a client, which hold any number of lines or parts of one. */
  | {
      readonly kind: "data";
      readonly client: ClientId;
      readonly chunk: Uint8Array;
    }
  /** The client will send nothing more; it may still read. */
  | { readonly kind: "client-ended"; readonly client: ClientId }
  /** The connection is gone, both ways. */
  | { readonly kind: "client-closed"; readonly client: ClientId }
  /** One message from the extension, as its JSON text. */
  | { readonly kind: "extension-message"; readonly text: string }
  /** The request's timer ran out, after the given time. */
  | { readonly kind: "timeout"; readonly id: string; readonly afterMs: number }
  /** Chrome closed the port, or the host was told to stop. */
  | { readonly kind: "port-closed" };

export type RouterEffect =
  | { readonly kind: "write-frame"; readonly message: RequestEnvelope }
  | {
      readonly kind: "write-line";
      readonly client: ClientId;
      readonly line: string;
    }
  /** Close the connection once the lines written to it have gone. */
  | { readonly kind: "close-client"; readonly client: ClientId }
  | { readonly kind: "start-timer"; readonly id: string }
  | { readonly kind: "cancel-timer"; readonly id: string }
  | { readonly kind: "log"; readonly message: string }
  /** Every client is answered and closed: stop serving and exit. */
  | { readonly kind: "stop" };

export type RouterTransition = {
  readonly state: RouterState;
  readonly effects: readonly RouterEffect[];
};

const unchanged = (state: RouterState): RouterTransition => ({
  state,
  effects: [],
});

const withClient = (
  clients: ReadonlyMap<ClientId, Client>,
  id: ClientId,
  client: Client | null,
): ReadonlyMap<ClientId, Client> =>
  client === null
    ? new Map([...clients].filter(([key]) => key !== id))
    : new Map([...clients, [id, client]]);

const withoutPending = (
  pending: ReadonlyMap<string, ClientId>,
  ids: readonly string[],
): ReadonlyMap<string, ClientId> =>
  new Map([...pending].filter(([key]) => !ids.includes(key)));

/**
 * Writes the client's ready lines from the head of its queue, up to the
 * first request still waiting, and closes a closing client whose queue is
 * then empty.
 */
const flush = (state: RouterState, id: ClientId): RouterTransition => {
  const client = state.clients.get(id);
  if (client === undefined) {
    return unchanged(state);
  }
  const waiting = client.queue.findIndex((slot) => slot.kind === "waiting");
  const ready = waiting === -1 ? client.queue : client.queue.slice(0, waiting);
  const queue = client.queue.slice(ready.length);
  const writes: readonly RouterEffect[] = ready.flatMap((slot) =>
    slot.kind === "ready"
      ? [{ kind: "write-line", client: id, line: slot.line }]
      : [],
  );
  const done = client.closing && queue.length === 0;
  return {
    state: {
      ...state,
      clients: withClient(
        state.clients,
        id,
        done ? null : { ...client, queue },
      ),
    },
    effects: done ? [...writes, { kind: "close-client", client: id }] : writes,
  };
};

/** Fills the waiting slot of request `id` with its response. */
const fill = (client: Client, id: string, response: Response): Client => ({
  ...client,
  queue: client.queue.map((slot) =>
    slot.kind === "waiting" && slot.id === id ? ready(response) : slot,
  ),
});

/** Answers request `id` with `response`, if it is still pending. */
const answer = (
  state: RouterState,
  id: string,
  response: Response,
): RouterTransition | null => {
  const clientId = state.pending.get(id);
  if (clientId === undefined) {
    return null;
  }
  const client = state.clients.get(clientId);
  const pending = withoutPending(state.pending, [id]);
  if (client === undefined) {
    return { state: { ...state, pending }, effects: [] };
  }
  return flush(
    {
      ...state,
      pending,
      clients: withClient(state.clients, clientId, fill(client, id, response)),
    },
    clientId,
  );
};

const then = (
  first: readonly RouterEffect[],
  next: RouterTransition,
): RouterTransition => ({
  state: next.state,
  effects: [...first, ...next.effects],
});

const ready = (response: Response): Slot => ({
  kind: "ready",
  line: encode(response),
});

const overflowFailure = failure(
  "invalid-request",
  `the request line is longer than ${MAX_REQUEST_LINE_BYTES} bytes`,
);

/**
 * Takes a client's lines: a line that fails to parse gets its failure at
 * once, in its place in the queue; a valid request goes to the port with a
 * fresh `id`. After `overflow`, the client is answered `invalid-request`
 * and closed once its earlier requests are answered.
 */
const takeLines = (
  state: RouterState,
  id: ClientId,
  client: Client,
  lines: readonly string[],
  closing: boolean,
  overflow: boolean,
): RouterTransition => {
  const parsed = lines.map(
    (
      line,
      index,
    ): { readonly slot: Slot; readonly envelope: RequestEnvelope | null } => {
      const request = parseRequest(line);
      const requestId = String(state.nextId + index);
      return request.ok
        ? {
            slot: { kind: "waiting", id: requestId },
            envelope: { id: requestId, request: request.value },
          }
        : { slot: ready(request.error), envelope: null };
    },
  );
  const envelopes = parsed.flatMap(({ envelope }) =>
    envelope === null ? [] : [envelope],
  );
  const pending: ReadonlyMap<string, ClientId> = new Map([
    ...state.pending,
    ...envelopes.map((envelope) => [envelope.id, id] as const),
  ]);
  const queue: readonly Slot[] = [
    ...client.queue,
    ...parsed.map(({ slot }) => slot),
    ...(overflow ? [ready(overflowFailure)] : []),
  ];
  return then(
    envelopes.flatMap((envelope): readonly RouterEffect[] => [
      { kind: "write-frame", message: envelope },
      { kind: "start-timer", id: envelope.id },
    ]),
    flush(
      {
        ...state,
        nextId: state.nextId + lines.length,
        pending,
        clients: withClient(state.clients, id, {
          ...client,
          queue,
          closing: client.closing || closing || overflow,
        }),
      },
      id,
    ),
  );
};

const onData = (
  state: RouterState,
  id: ClientId,
  chunk: Uint8Array,
): RouterTransition => {
  const client = state.clients.get(id);
  if (client === undefined || client.closing) {
    return unchanged(state);
  }
  const split = splitLines(client.lines, chunk, MAX_REQUEST_LINE_BYTES);
  return takeLines(
    state,
    id,
    { ...client, lines: split.state },
    split.lines,
    false,
    split.overflow,
  );
};

const onEnded = (state: RouterState, id: ClientId): RouterTransition => {
  const client = state.clients.get(id);
  if (client === undefined || client.closing) {
    return unchanged(state);
  }
  const last = finishLines(client.lines);
  return takeLines(
    state,
    id,
    { ...client, lines: INITIAL_LINE_STATE },
    last === null ? [] : [last],
    true,
    false,
  );
};

/** Drops the client and its pending requests, whose answers have nobody to go to. */
const onClosed = (state: RouterState, id: ClientId): RouterTransition => {
  if (!state.clients.has(id)) {
    return unchanged(state);
  }
  const abandoned = [...state.pending]
    .filter(([, client]) => client === id)
    .map(([request]) => request);
  return {
    state: {
      ...state,
      clients: withClient(state.clients, id, null),
      pending: withoutPending(state.pending, abandoned),
    },
    effects: abandoned.map((request) => ({
      kind: "cancel-timer",
      id: request,
    })),
  };
};

const log = (message: string): RouterEffect => ({ kind: "log", message });

/**
 * A message from the extension: the response to a pending request. A
 * message that fails validation is reported; when it names a pending
 * request, that request is answered with the fault, so its client is not
 * left waiting for the timeout.
 */
const parseJson = (text: string): { readonly value: unknown } | null => {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return null;
  }
};

const onExtensionMessage = (
  state: RouterState,
  text: string,
): RouterTransition => {
  const json = parseJson(text);
  if (json === null) {
    return {
      state,
      effects: [log("a message from the extension is not JSON")],
    };
  }
  const checked = validateExtensionMessage(json.value);
  if (checked.ok) {
    const { id, response } = checked.value;
    const answered = answer(state, id, response);
    return answered === null
      ? {
          state,
          effects: [
            log(
              `the extension answered request ${JSON.stringify(id)}, which nobody is waiting for`,
            ),
          ],
        }
      : then([{ kind: "cancel-timer", id }], answered);
  }
  const { id, failure: fault } = checked.error;
  const report = log(
    `a message from the extension is not usable: ${fault.error.message}`,
  );
  const answered = id === null ? null : answer(state, id, fault);
  return id === null || answered === null
    ? { state, effects: [report] }
    : then([report, { kind: "cancel-timer", id }], answered);
};

/** A time in milliseconds as seconds, such as "120 seconds" or "0.2 seconds". */
export const secondsText = (ms: number): string =>
  ms === 1000 ? "1 second" : `${ms / 1000} seconds`;

const onTimeout = (
  state: RouterState,
  id: string,
  afterMs: number,
): RouterTransition =>
  answer(
    state,
    id,
    failure(
      "internal",
      `the extension did not answer within ${secondsText(afterMs)}`,
    ),
  ) ?? unchanged(state);

const notConnected = failure(
  "not-connected",
  "Chrome closed the connection to the extension before it answered",
);

/** Answers every pending request `not-connected`, closes every client, and stops. */
const onPortClosed = (state: RouterState): RouterTransition => {
  const ids = [...state.pending.keys()];
  const answered = ids.reduce<RouterTransition>(
    (done, id) =>
      then(
        done.effects,
        answer(done.state, id, notConnected) ?? unchanged(done.state),
      ),
    unchanged(state),
  );
  const closes = [...answered.state.clients.keys()].map(
    (client): RouterEffect => ({ kind: "close-client", client }),
  );
  return {
    state: {
      ...answered.state,
      clients: new Map(),
      pending: new Map(),
      stopped: true,
    },
    effects: [
      ...ids.map((id): RouterEffect => ({ kind: "cancel-timer", id })),
      ...answered.effects,
      ...closes,
      { kind: "stop" },
    ],
  };
};

/** The router's next state and the effects to carry out, in order. */
export const route = (
  state: RouterState,
  event: RouterEvent,
): RouterTransition => {
  if (state.stopped) {
    return unchanged(state);
  }
  switch (event.kind) {
    case "client-connected":
      return state.clients.has(event.client)
        ? unchanged(state)
        : {
            state: {
              ...state,
              clients: withClient(state.clients, event.client, {
                lines: INITIAL_LINE_STATE,
                queue: [],
                closing: false,
              }),
            },
            effects: [],
          };
    case "data":
      return onData(state, event.client, event.chunk);
    case "client-ended":
      return onEnded(state, event.client);
    case "client-closed":
      return onClosed(state, event.client);
    case "extension-message":
      return onExtensionMessage(state, event.text);
    case "timeout":
      return onTimeout(state, event.id, event.afterMs);
    case "port-closed":
      return onPortClosed(state);
  }
};
