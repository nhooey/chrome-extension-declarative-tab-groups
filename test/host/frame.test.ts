import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decodeFrames,
  encodeFrame,
  type FrameState,
  INITIAL_FRAME_STATE,
  MAX_FRAME_BYTES,
} from "../../src/host/frame.ts";

const lengthPrefix = (length: number, littleEndian: boolean): Uint8Array => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, length, littleEndian);
  return bytes;
};

/** Feeds the chunks one after another, collecting every message and error. */
const feed = (
  chunks: readonly Uint8Array[],
): {
  readonly messages: readonly string[];
  readonly errors: readonly string[];
} => {
  const start: {
    readonly state: FrameState;
    readonly messages: readonly string[];
    readonly errors: readonly string[];
  } = { state: INITIAL_FRAME_STATE, messages: [], errors: [] };
  const end = chunks.reduce((done, chunk) => {
    const decoded = decodeFrames(done.state, chunk, "LE");
    return {
      state: decoded.state,
      messages: [...done.messages, ...decoded.messages],
      errors:
        decoded.error === null ? done.errors : [...done.errors, decoded.error],
    };
  }, start);
  return { messages: end.messages, errors: end.errors };
};

describe("encodeFrame", () => {
  it("writes the UTF-8 length in the given byte order, then the JSON", () => {
    const message = { hello: { protocol: 1 }, title: "Café ☕" };
    const body = new TextEncoder().encode(JSON.stringify(message));
    const little = encodeFrame(message, "LE");
    assert.deepEqual(little.subarray(0, 4), lengthPrefix(body.length, true));
    assert.deepEqual(little.subarray(4), body);
    const big = encodeFrame(message, "BE");
    assert.deepEqual(big.subarray(0, 4), lengthPrefix(body.length, false));
  });
});

describe("decodeFrames", () => {
  const first = { id: "1", response: { protocol: 1, title: "Café ☕" } };
  const second = { id: "2" };
  const stream = new Uint8Array([
    ...encodeFrame(first, "LE"),
    ...encodeFrame(second, "LE"),
  ]);

  it("reads several frames from one chunk", () => {
    assert.deepEqual(feed([stream]), {
      messages: [JSON.stringify(first), JSON.stringify(second)],
      errors: [],
    });
  });

  it("reads the same frames fed one byte at a time", () => {
    const bytes = Array.from(stream, (byte) => new Uint8Array([byte]));
    assert.deepEqual(feed(bytes), {
      messages: [JSON.stringify(first), JSON.stringify(second)],
      errors: [],
    });
  });

  it("waits for a frame's last byte", () => {
    const decoded = decodeFrames(
      INITIAL_FRAME_STATE,
      stream.subarray(0, stream.length - 1),
      "LE",
    );
    assert.deepEqual(decoded.messages, [JSON.stringify(first)]);
    assert.equal(decoded.state.length, encodeFrame(second, "LE").length - 1);
  });

  it("reads the length in the given byte order", () => {
    const decoded = decodeFrames(
      INITIAL_FRAME_STATE,
      encodeFrame(second, "BE"),
      "BE",
    );
    assert.deepEqual(decoded.messages, [JSON.stringify(second)]);
  });

  it("rejects a declared length over Chrome's limit from its 4 bytes alone", () => {
    const decoded = decodeFrames(
      INITIAL_FRAME_STATE,
      lengthPrefix(MAX_FRAME_BYTES + 1, true),
      "LE",
    );
    assert.deepEqual(decoded.messages, []);
    assert.match(
      decoded.error ?? "",
      /declares 67108865 bytes, over Chrome's limit/,
    );
    assert.deepEqual(
      feed([lengthPrefix(0xffffffff, true)]).errors.length,
      1,
      "a 4 GiB length is an error, not an allocation",
    );
  });

  it("accepts a declared length at the limit and waits for its body", () => {
    const decoded = decodeFrames(
      INITIAL_FRAME_STATE,
      lengthPrefix(MAX_FRAME_BYTES, true),
      "LE",
    );
    assert.equal(decoded.error, null);
    assert.equal(decoded.state.length, 4);
  });

  it("changes neither its state nor its chunk", () => {
    const chunk = encodeFrame(second, "LE");
    const copy = chunk.slice();
    const state = decodeFrames(
      INITIAL_FRAME_STATE,
      chunk.subarray(0, 3),
      "LE",
    ).state;
    decodeFrames(state, chunk.subarray(3), "LE");
    assert.deepEqual(chunk, copy);
    assert.equal(state.length, 3);
  });
});
