import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  INITIAL_ROUTER_STATE,
  REQUEST_TIMEOUT_MS,
  route,
  type RouterEffect,
  type RouterEvent,
  type RouterState,
} from "../../src/host/router.ts";
import {
  encode,
  failure,
  MAX_REQUEST_LINE_BYTES,
  type Response,
} from "../../src/protocol/index.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The state and every effect after a run of events. */
const run = (
  events: readonly RouterEvent[],
  from: RouterState = INITIAL_ROUTER_STATE,
): { readonly state: RouterState; readonly effects: readonly RouterEffect[] } =>
  events.reduce(
    (done, event) => {
      const next = route(done.state, event);
      return { state: next.state, effects: [...done.effects, ...next.effects] };
    },
    { state: from, effects: [] as readonly RouterEffect[] },
  );

const connect = (client: number): RouterEvent => ({
  kind: "client-connected",
  client,
});
const data = (client: number, text: string): RouterEvent => ({
  kind: "data",
  client,
  chunk: bytes(text),
});
const answer = (id: string, response: Response): RouterEvent => ({
  kind: "extension-message",
  text: JSON.stringify({ id, response }),
});

const status = '{"protocol":1,"command":"status"}\n';
const get = (group: string) =>
  `${JSON.stringify({ protocol: 1, command: "get", group })}\n`;

const statusResponse = (chrome: string): Response => ({
  protocol: 1,
  ok: true,
  command: "status",
  extension: "0.1.0",
  chrome,
});

const writes = (effects: readonly RouterEffect[], client: number) =>
  effects.flatMap((effect) =>
    effect.kind === "write-line" && effect.client === client
      ? [effect.line]
      : [],
  );

const frames = (effects: readonly RouterEffect[]) =>
  effects.flatMap((effect) =>
    effect.kind === "write-frame" ? [effect.message] : [],
  );

const kinds = (effects: readonly RouterEffect[]) =>
  effects.map((effect) => effect.kind);

describe("the router: requests", () => {
  it("sends a valid request to the port with a fresh id, and starts its timer", () => {
    const { effects } = run([connect(1), data(1, status)]);
    assert.deepEqual(effects, [
      {
        kind: "write-frame",
        message: { id: "1", request: { protocol: 1, command: "status" } },
      },
      { kind: "start-timer", id: "1" },
    ]);
  });

  it("gives every unanswered request its own id, across clients", () => {
    const { effects } = run([
      connect(1),
      connect(2),
      data(1, status + status),
      data(2, status),
    ]);
    assert.deepEqual(
      frames(effects).map((frame) => frame.id),
      ["1", "2", "3"],
    );
  });

  it("answers a line that fails to parse at once, without the port", () => {
    const { effects } = run([connect(1), data(1, "not json\n")]);
    assert.deepEqual(effects, [
      {
        kind: "write-line",
        client: 1,
        line: encode(
          failure("invalid-request", "the request line is not valid JSON"),
        ),
      },
    ]);
  });

  it("relays the extension's response to the client that asked", () => {
    const response = statusResponse("142.0");
    const { effects } = run([
      connect(1),
      connect(2),
      data(2, status),
      answer("1", response),
    ]);
    assert.deepEqual(effects.slice(2), [
      { kind: "cancel-timer", id: "1" },
      { kind: "write-line", client: 2, line: encode(response) },
    ]);
  });

  it("delivers responses in request order when the extension answers out of order", () => {
    const first = statusResponse("first");
    const second = statusResponse("second");
    const sent = run([connect(1), data(1, status + get("Reading"))]);
    const early = run([answer("2", second)], sent.state);
    assert.deepEqual(
      writes(early.effects, 1),
      [],
      "the second waits for the first",
    );
    const late = run([answer("1", first)], early.state);
    assert.deepEqual(writes(late.effects, 1), [encode(first), encode(second)]);
  });

  it("keeps an invalid line's answer in its place behind a pending request", () => {
    const response = statusResponse("142.0");
    const { effects } = run([
      connect(1),
      data(1, `${status}nope\n`),
      answer("1", response),
    ]);
    assert.deepEqual(writes(effects, 1), [
      encode(response),
      encode(failure("invalid-request", "the request line is not valid JSON")),
    ]);
  });
});

describe("the router: bounds and ends", () => {
  it("answers a line over the bound with invalid-request and closes the client", () => {
    const { state, effects } = run([
      connect(1),
      data(1, "x".repeat(MAX_REQUEST_LINE_BYTES)),
      data(1, "x"),
      data(1, status),
    ]);
    assert.deepEqual(effects, [
      {
        kind: "write-line",
        client: 1,
        line: encode(
          failure(
            "invalid-request",
            `the request line is longer than ${MAX_REQUEST_LINE_BYTES} bytes`,
          ),
        ),
      },
      { kind: "close-client", client: 1 },
    ]);
    assert.equal(state.clients.size, 0);
  });

  it("answers the requests before an overflow first, then closes", () => {
    const response = statusResponse("142.0");
    const { effects } = run([
      connect(1),
      data(1, status + "x".repeat(MAX_REQUEST_LINE_BYTES + 1)),
      answer("1", response),
    ]);
    assert.deepEqual(kinds(effects), [
      "write-frame",
      "start-timer",
      "cancel-timer",
      "write-line",
      "write-line",
      "close-client",
    ]);
  });

  it("takes a last line without its newline when the client ends, then closes once answered", () => {
    const response = statusResponse("142.0");
    const sent = run([
      connect(1),
      data(1, status.trimEnd()),
      { kind: "client-ended", client: 1 },
    ]);
    assert.deepEqual(kinds(sent.effects), ["write-frame", "start-timer"]);
    const answered = run([answer("1", response)], sent.state);
    assert.deepEqual(answered.effects.slice(1), [
      { kind: "write-line", client: 1, line: encode(response) },
      { kind: "close-client", client: 1 },
    ]);
  });

  it("drops a closed client's pending responses", () => {
    const { state, effects } = run([
      connect(1),
      data(1, status),
      { kind: "client-closed", client: 1 },
      answer("1", statusResponse("142.0")),
    ]);
    assert.deepEqual(kinds(effects), [
      "write-frame",
      "start-timer",
      "cancel-timer",
      "log",
    ]);
    assert.equal(state.pending.size, 0);
  });

  it("answers internal a request the extension leaves unanswered for 120 seconds", () => {
    assert.equal(REQUEST_TIMEOUT_MS, 120_000);
    const late = statusResponse("late");
    const { effects } = run([
      connect(1),
      data(1, status),
      { kind: "timeout", id: "1", afterMs: REQUEST_TIMEOUT_MS },
      answer("1", late),
    ]);
    assert.deepEqual(writes(effects, 1), [
      encode(
        failure("internal", "the extension did not answer within 120 seconds"),
      ),
    ]);
  });

  it("names the time the timer ran, whatever the host was given", () => {
    const answered = (afterMs: number): readonly string[] =>
      writes(
        run([
          connect(1),
          data(1, status),
          { kind: "timeout", id: "1", afterMs },
        ]).effects,
        1,
      );
    assert.deepEqual(answered(2_500), [
      encode(
        failure("internal", "the extension did not answer within 2.5 seconds"),
      ),
    ]);
    assert.deepEqual(answered(1_000), [
      encode(
        failure("internal", "the extension did not answer within 1 second"),
      ),
    ]);
  });

  it("ignores a timeout for a request already answered", () => {
    const response = statusResponse("142.0");
    const { effects } = run([
      connect(1),
      data(1, status),
      answer("1", response),
      { kind: "timeout", id: "1", afterMs: REQUEST_TIMEOUT_MS },
    ]);
    assert.deepEqual(writes(effects, 1), [encode(response)]);
  });
});

describe("the router: the extension's messages", () => {
  it("reports a message that is not JSON and changes nothing", () => {
    const sent = run([connect(1), data(1, status)]);
    const next = route(sent.state, { kind: "extension-message", text: "{" });
    assert.deepEqual(next, {
      state: sent.state,
      effects: [
        { kind: "log", message: "a message from the extension is not JSON" },
      ],
    });
  });

  it("reports a message without a usable id and changes nothing", () => {
    const sent = run([connect(1), data(1, status)]);
    const next = route(sent.state, {
      kind: "extension-message",
      text: '{"response":{}}',
    });
    assert.equal(next.state, sent.state);
    assert.deepEqual(kinds(next.effects), ["log"]);
  });

  it("reports a malformed response to a pending request and answers its client with the fault", () => {
    const { effects } = run([
      connect(1),
      data(1, status),
      {
        kind: "extension-message",
        text: '{"id":"1","response":{"protocol":1}}',
      },
    ]);
    assert.deepEqual(kinds(effects).slice(2), [
      "log",
      "cancel-timer",
      "write-line",
    ]);
    assert.match(
      writes(effects, 1)[0] ?? "",
      /"code":"internal".*malformed response/,
    );
  });
});

describe("the router: the port closing", () => {
  it("answers every pending request not-connected, closes every client and stops", () => {
    const { state, effects } = run([
      connect(1),
      connect(2),
      data(1, status + status),
      data(2, status),
      { kind: "port-closed" },
    ]);
    const notConnected = encode(
      failure(
        "not-connected",
        "Chrome closed the connection to the extension before it answered",
      ),
    );
    assert.deepEqual(writes(effects, 1), [notConnected, notConnected]);
    assert.deepEqual(writes(effects, 2), [notConnected]);
    assert.deepEqual(kinds(effects).slice(-3), [
      "close-client",
      "close-client",
      "stop",
    ]);
    assert.equal(state.stopped, true);
    assert.deepEqual(route(state, data(1, status)), { state, effects: [] });
  });

  it("stops at once with no clients", () => {
    assert.deepEqual(run([{ kind: "port-closed" }]).effects, [
      { kind: "stop" },
    ]);
  });
});
