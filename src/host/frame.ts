// Chrome's native-messaging framing on the host's standard input and
// output: each message is a 4-byte length in the machine's byte order,
// then that many bytes of UTF-8 JSON. Pure: bytes in, bytes or texts out.

/** The byte order of the length, as `os.endianness()` names it. */
export type ByteOrder = "LE" | "BE";

/** Chrome's cap on one message from the extension to the host: 64 MiB. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

const LENGTH_BYTES = 4;

/** The message as one frame: its length, then its JSON text in UTF-8. */
export const encodeFrame = (message: unknown, order: ByteOrder): Uint8Array => {
  const body = new TextEncoder().encode(JSON.stringify(message));
  const frame = new Uint8Array(LENGTH_BYTES + body.length);
  new DataView(frame.buffer).setUint32(0, body.length, order === "LE");
  frame.set(body, LENGTH_BYTES);
  return frame;
};

/**
 * The bytes received that do not yet make a whole frame, kept as the chunks
 * they came in, so a large frame arriving in many chunks is joined once.
 */
export type FrameState = {
  readonly chunks: readonly Uint8Array[];
  readonly length: number;
};

export const INITIAL_FRAME_STATE: FrameState = { chunks: [], length: 0 };

export type Decoded = {
  readonly state: FrameState;
  /** The whole messages the chunk completed, as JSON texts, in order. */
  readonly messages: readonly string[];
  /** Set when a frame declares a length over `MAX_FRAME_BYTES`; nothing after it is read. */
  readonly error: string | null;
};

/** The chunks' first `count` bytes, joined into a new array. */
const join = (chunks: readonly Uint8Array[], count: number): Uint8Array => {
  const joined = new Uint8Array(count);
  let filled = 0;
  for (const chunk of chunks) {
    if (filled === count) {
      break;
    }
    const part = chunk.subarray(0, count - filled);
    joined.set(part, filled);
    filled += part.length;
  }
  return joined;
};

const lengthAt = (bytes: Uint8Array, offset: number, order: ByteOrder) =>
  new DataView(bytes.buffer, bytes.byteOffset + offset, LENGTH_BYTES).getUint32(
    0,
    order === "LE",
  );

/**
 * Reads the frames a chunk completes. A length over `MAX_FRAME_BYTES` is an
 * error found from the 4 length bytes alone, before any allocation for its
 * body. Neither the state nor the chunk is changed.
 */
export const decodeFrames = (
  state: FrameState,
  chunk: Uint8Array,
  order: ByteOrder,
): Decoded => {
  const chunks = [...state.chunks, chunk.slice()];
  const length = state.length + chunk.length;
  if (length < LENGTH_BYTES) {
    return { state: { chunks, length }, messages: [], error: null };
  }
  const declared = lengthAt(join(chunks, LENGTH_BYTES), 0, order);
  if (declared <= MAX_FRAME_BYTES && length < LENGTH_BYTES + declared) {
    return { state: { chunks, length }, messages: [], error: null };
  }
  const bytes = join(chunks, length);
  const decoder = new TextDecoder();
  const messages: string[] = [];
  let offset = 0;
  while (bytes.length - offset >= LENGTH_BYTES) {
    const length = lengthAt(bytes, offset, order);
    if (length > MAX_FRAME_BYTES) {
      return {
        state: INITIAL_FRAME_STATE,
        messages,
        error: `a native message declares ${length} bytes, over Chrome's limit of ${MAX_FRAME_BYTES}`,
      };
    }
    const start = offset + LENGTH_BYTES;
    if (bytes.length - start < length) {
      break;
    }
    messages.push(decoder.decode(bytes.subarray(start, start + length)));
    offset = start + length;
  }
  const rest = bytes.slice(offset);
  return {
    state: { chunks: rest.length === 0 ? [] : [rest], length: rest.length },
    messages,
    error: null,
  };
};
