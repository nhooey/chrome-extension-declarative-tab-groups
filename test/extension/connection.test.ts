import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type ConnectionEvent,
  type ConnectionState,
  eventFromMessage,
  INITIAL_STATE,
  transition,
  type Transition,
} from "../../src/extension/connection.ts";
import { failure, type RequestEnvelope } from "../../src/protocol/index.ts";

const disconnected: ConnectionState = { kind: "disconnected" };
const connecting: ConnectionState = { kind: "connecting" };
const serving: ConnectionState = { kind: "serving" };
const stopped: ConnectionState = { kind: "stopped" };
const STATES = [disconnected, connecting, serving, stopped];

const envelope: RequestEnvelope = {
  id: "7",
  request: { protocol: 1, command: "status" },
};

/** The states and effects of a run of events from the initial state. */
const runEvents = (events: readonly ConnectionEvent[]): readonly Transition[] =>
  events.reduce<readonly Transition[]>(
    (done, event) => [
      ...done,
      transition(done.at(-1)?.state ?? INITIAL_STATE, event),
    ],
    [],
  );

const kinds = (step: Transition) => step.effects.map((effect) => effect.kind);

describe("the connection: connecting", () => {
  it("connects on start, and serves once the hello is accepted", () => {
    const [start, hello] = runEvents([
      { kind: "start" },
      { kind: "hello", hello: { protocol: 1 } },
    ]);
    assert.deepEqual(start, {
      state: connecting,
      effects: [{ kind: "connect" }, { kind: "start-hello-timer" }],
    });
    assert.deepEqual(hello, {
      state: serving,
      effects: [{ kind: "cancel-reconnect" }],
    });
  });

  it("drops a port with no hello in 10 seconds and retries from the alarm", () => {
    const [, timedOut, alarm] = runEvents([
      { kind: "start" },
      { kind: "hello-timeout" },
      { kind: "alarm" },
    ]);
    assert.deepEqual(timedOut, {
      state: disconnected,
      effects: [
        { kind: "disconnect" },
        { kind: "schedule-reconnect" },
        { kind: "log", message: "the host sent no hello within 10 seconds" },
      ],
    });
    assert.deepEqual(alarm?.state, connecting);
  });

  it("ignores the hello timer once the hello came or the port went", () => {
    for (const state of [disconnected, serving, stopped]) {
      assert.deepEqual(transition(state, { kind: "hello-timeout" }), {
        state,
        effects: [],
      });
    }
  });

  it("connects only once however often it starts", () => {
    for (const state of [connecting, serving, stopped]) {
      assert.deepEqual(transition(state, { kind: "start" }), {
        state,
        effects: [],
      });
    }
  });
});

describe("the connection: refusals", () => {
  it("stops for good when the host refuses this browser", () => {
    const refused = transition(connecting, {
      kind: "hello",
      hello: { refused: "not-google-chrome" },
    });
    assert.deepEqual(refused.state, stopped);
    assert.deepEqual(kinds(refused), ["disconnect", "cancel-reconnect", "log"]);
    for (const event of [
      { kind: "alarm" },
      { kind: "start" },
      { kind: "disconnected", reason: null },
    ] as const) {
      assert.deepEqual(transition(stopped, event).state, stopped);
      assert.equal(
        kinds(transition(stopped, event)).includes("connect"),
        false,
      );
    }
  });

  it("retries from the alarm when another host serves the socket", () => {
    const refused = transition(connecting, {
      kind: "hello",
      hello: { refused: "socket-in-use" },
    });
    assert.deepEqual(refused.state, disconnected);
    assert.deepEqual(kinds(refused), [
      "disconnect",
      "schedule-reconnect",
      "log",
    ]);
  });

  it("retries from the alarm when the hello is of another protocol", () => {
    const event = eventFromMessage({ hello: { protocol: 2 } });
    assert.equal(event.kind, "fault");
    const next = transition(connecting, event);
    assert.deepEqual(next.state, disconnected);
    assert.deepEqual(kinds(next), ["disconnect", "schedule-reconnect", "log"]);
  });
});

describe("the connection: losing the port", () => {
  it("schedules the reconnect alarm when the port closes", () => {
    for (const state of [connecting, serving]) {
      const next = transition(state, {
        kind: "disconnected",
        reason: "Native host has exited.",
      });
      assert.deepEqual(next, {
        state: disconnected,
        effects: [
          { kind: "schedule-reconnect" },
          {
            kind: "log",
            message: "the host's port closed: Native host has exited.",
          },
        ],
      });
    }
  });

  it("reconnects when the alarm fires, and ignores a stale alarm", () => {
    assert.deepEqual(transition(disconnected, { kind: "alarm" }), {
      state: connecting,
      effects: [{ kind: "connect" }, { kind: "start-hello-timer" }],
    });
    assert.deepEqual(transition(connecting, { kind: "alarm" }), {
      state: connecting,
      effects: [],
    });
    assert.deepEqual(transition(serving, { kind: "alarm" }), {
      state: serving,
      effects: [{ kind: "cancel-reconnect" }],
    });
  });

  it("never connects twice without an event between", () => {
    for (const state of STATES) {
      for (const event of [{ kind: "start" }, { kind: "alarm" }] as const) {
        const next = transition(state, event);
        const connects = kinds(next).filter((kind) => kind === "connect");
        assert.ok(connects.length <= 1);
        if (connects.length === 1) {
          assert.deepEqual(kinds(transition(next.state, event)), []);
        }
      }
    }
  });
});

describe("the connection: requests", () => {
  it("handles a request while serving", () => {
    assert.deepEqual(transition(serving, { kind: "request", envelope }), {
      state: serving,
      effects: [{ kind: "handle", envelope }],
    });
  });

  it("answers a request before the hello with a failure", () => {
    assert.deepEqual(transition(connecting, { kind: "request", envelope }), {
      state: connecting,
      effects: [
        {
          kind: "post",
          envelope: {
            id: "7",
            response: failure(
              "internal",
              "the host sent a request before the extension accepted its hello",
            ),
          },
        },
      ],
    });
  });

  it("answers an invalid request with its failure under its id", () => {
    const event = eventFromMessage({
      id: "8",
      request: { protocol: 1, command: "get" },
    });
    assert.deepEqual(transition(serving, event), {
      state: serving,
      effects: [
        {
          kind: "post",
          envelope: {
            id: "8",
            response: failure("invalid-request", 'missing field "group"'),
          },
        },
      ],
    });
  });

  it("logs a message it cannot answer", () => {
    const next = transition(serving, eventFromMessage([1, 2]));
    assert.equal(next.state, serving);
    assert.deepEqual(kinds(next), ["log"]);
  });
});

describe("eventFromMessage", () => {
  it("tells a hello from a request", () => {
    assert.deepEqual(eventFromMessage({ hello: { protocol: 1 } }), {
      kind: "hello",
      hello: { protocol: 1 },
    });
    assert.deepEqual(eventFromMessage(envelope), {
      kind: "request",
      envelope,
    });
  });
});
