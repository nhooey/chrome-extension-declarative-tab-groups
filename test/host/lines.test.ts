import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  finishLines,
  INITIAL_LINE_STATE,
  type LineState,
  splitLines,
} from "../../src/host/lines.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const feed = (
  chunks: readonly string[],
  limit: number,
): {
  readonly state: LineState;
  readonly lines: readonly string[];
  readonly overflows: number;
} =>
  chunks.reduce(
    (done, chunk) => {
      const split = splitLines(done.state, bytes(chunk), limit);
      return {
        state: split.state,
        lines: [...done.lines, ...split.lines],
        overflows: done.overflows + (split.overflow ? 1 : 0),
      };
    },
    {
      state: INITIAL_LINE_STATE,
      lines: [] as readonly string[],
      overflows: 0,
    },
  );

describe("splitLines", () => {
  it("splits lines across and within chunks", () => {
    const result = feed(['{"a":', '1}\n{"b":2}\n{"c"', ":3}\n"], 100);
    assert.deepEqual(result.lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
    assert.equal(result.overflows, 0);
    assert.equal(finishLines(result.state), null);
  });

  it("decodes a character split between chunks", () => {
    const text = bytes("café\n");
    const split = splitLines(INITIAL_LINE_STATE, text.subarray(0, 4), 100);
    const rest = splitLines(split.state, text.subarray(4), 100);
    assert.deepEqual(rest.lines, ["café"]);
  });

  it("keeps an empty line", () => {
    assert.deepEqual(feed(["\n\n"], 100).lines, ["", ""]);
  });

  it("accepts a line of exactly the limit, counted in UTF-8 bytes", () => {
    assert.deepEqual(feed(["é".repeat(5), "\n"], 10).lines, ["é".repeat(5)]);
    const over = feed(["é".repeat(5), "x\n"], 10);
    assert.deepEqual(over.lines, []);
    assert.equal(over.overflows, 1);
  });

  it("overflows once a line without its end goes over the limit, and reads nothing after", () => {
    const result = feed(
      ["ok\n", "x".repeat(6), "x".repeat(6), "\nlater\n"],
      10,
    );
    assert.deepEqual(result.lines, ["ok"]);
    assert.equal(result.overflows, 1);
    assert.equal(result.state.overflowed, true);
    assert.equal(result.state.length, 0, "the overflowing bytes are dropped");
    assert.equal(finishLines(result.state), null);
  });

  it("overflows on a whole line over the limit in one chunk, after the lines before it", () => {
    const result = feed([`a\n${"x".repeat(11)}\nb\n`], 10);
    assert.deepEqual(result.lines, ["a"]);
    assert.equal(result.overflows, 1);
  });

  it("gives the text left without a newline when the connection ends", () => {
    assert.equal(finishLines(feed(["a\nlast"], 100).state), "last");
  });
});
