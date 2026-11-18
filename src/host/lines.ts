// The socket's lines, split from the bytes a connection delivers, with a
// bound on a line's length so a client that never sends `\n` cannot make
// the reader buffer without end. Pure: the state and a chunk in, the new
// state and the whole lines out. The host and the command both use it.

/** The bytes of the line not yet ended, as the chunks they came in. */
export type LineState = {
  readonly chunks: readonly Uint8Array[];
  readonly length: number;
  /** A line went over the bound; nothing more is read. */
  readonly overflowed: boolean;
};

export const INITIAL_LINE_STATE: LineState = {
  chunks: [],
  length: 0,
  overflowed: false,
};

export type Split = {
  readonly state: LineState;
  /** The lines the chunk ended, without their `\n`, decoded as UTF-8. */
  readonly lines: readonly string[];
  /** Whether this chunk took a line over the bound, after `lines`. */
  readonly overflow: boolean;
};

const NEWLINE = 0x0a;

const join = (chunks: readonly Uint8Array[], length: number): Uint8Array => {
  const joined = new Uint8Array(length);
  chunks.reduce((offset, chunk) => {
    joined.set(chunk, offset);
    return offset + chunk.length;
  }, 0);
  return joined;
};

const OVERFLOWED: LineState = { chunks: [], length: 0, overflowed: true };

/**
 * Splits a chunk into lines. A line whose bytes, without its `\n`, go over
 * `limit` ends the reading: the result says `overflow`, the line's bytes
 * are dropped, and every later chunk is ignored. Neither the state nor the
 * chunk is changed.
 */
export const splitLines = (
  state: LineState,
  chunk: Uint8Array,
  limit: number,
): Split => {
  if (state.overflowed) {
    return { state, lines: [], overflow: false };
  }
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let chunks = state.chunks;
  let length = state.length;
  let offset = 0;
  for (;;) {
    const end = chunk.indexOf(NEWLINE, offset);
    const part = chunk.subarray(offset, end === -1 ? chunk.length : end);
    if (length + part.length > limit) {
      return { state: OVERFLOWED, lines, overflow: true };
    }
    if (end === -1) {
      return {
        state: {
          chunks: part.length === 0 ? chunks : [...chunks, part.slice()],
          length: length + part.length,
          overflowed: false,
        },
        lines,
        overflow: false,
      };
    }
    lines.push(decoder.decode(join([...chunks, part], length + part.length)));
    chunks = [];
    length = 0;
    offset = end + 1;
  }
};

/**
 * The text left when the connection ends: a last line without its `\n`,
 * or null when there is none or the reading overflowed.
 */
export const finishLines = (state: LineState): string | null =>
  state.overflowed || state.length === 0
    ? null
    : new TextDecoder().decode(join(state.chunks, state.length));
