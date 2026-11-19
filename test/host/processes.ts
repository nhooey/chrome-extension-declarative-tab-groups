// Stand-ins for Chrome and for a client: a host process driven over its
// pipes with real native-messaging framing, and a connection to its socket
// read line by line.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { endianness, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decodeFrames,
  encodeFrame,
  INITIAL_FRAME_STATE,
} from "../../src/host/frame.ts";
import { EXTENSION_ORIGIN } from "../../src/host/guard.ts";
import { INITIAL_LINE_STATE, splitLines } from "../../src/host/lines.ts";

export const LAUNCHER = fileURLToPath(
  new URL("./launch-host.ts", import.meta.url),
);
export const HOST_ENTRY = fileURLToPath(
  new URL("../../src/host/main.ts", import.meta.url),
);
export const COMMAND_ENTRY = fileURLToPath(
  new URL("../../src/command/main.ts", import.meta.url),
);

/** A new folder with a short path, so socket paths stay under macOS's limit. */
export const shortTemporaryFolder = (): Promise<string> =>
  mkdtemp(join(tmpdir(), "dtg-"));

/** Values that arrive one at a time, taken in order by `next`. */
const inbox = <T>() => {
  const values: T[] = [];
  const waiters: ((value: T | null) => void)[] = [];
  let ended = false;
  return {
    push: (value: T): void => {
      const waiter = waiters.shift();
      if (waiter === undefined) {
        values.push(value);
      } else {
        waiter(value);
      }
    },
    end: (): void => {
      ended = true;
      waiters.splice(0).forEach((waiter) => waiter(null));
    },
    /** The next value, or null once there will be none. */
    next: (): Promise<T | null> =>
      values.length > 0
        ? Promise.resolve(values.shift() as T)
        : ended
          ? Promise.resolve(null)
          : new Promise((resolve) => waiters.push(resolve)),
  };
};

export type HostProcess = {
  readonly child: ChildProcess;
  /** The host's next native message, or null once its output has ended. */
  readonly nextMessage: () => Promise<unknown>;
  readonly send: (message: unknown) => void;
  /** Ends the host's standard input, as Chrome does when it closes the port. */
  readonly closePort: () => void;
  /** The exit status. */
  readonly exited: Promise<number | null>;
  readonly stderr: () => string;
};

/** Starts a host program with the socket at `socket`, as Chrome would. */
export const startHost = (
  socket: string,
  options: {
    readonly entry?: string;
    readonly args?: readonly string[];
  } = {},
): HostProcess => {
  const child = spawn(
    process.execPath,
    [options.entry ?? LAUNCHER, ...(options.args ?? [EXTENSION_ORIGIN])],
    {
      env: { ...process.env, DECLARATIVE_TAB_GROUPS_SOCKET: socket },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const order = endianness();
  const messages = inbox<unknown>();
  let frames = INITIAL_FRAME_STATE;
  child.stdout?.on("data", (chunk: Uint8Array) => {
    const decoded = decodeFrames(frames, chunk, order);
    frames = decoded.state;
    decoded.messages.forEach((text) => messages.push(JSON.parse(text)));
  });
  child.stdout?.on("end", () => messages.end());
  let errors = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    errors += chunk.toString("utf8");
  });
  const exited = new Promise<number | null>((resolve) =>
    child.on("exit", (code) => resolve(code)),
  );
  return {
    child,
    nextMessage: messages.next,
    send: (message) => child.stdin?.write(encodeFrame(message, order)),
    closePort: () => child.stdin?.end(),
    exited,
    stderr: () => errors,
  };
};

export type Finished = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

/** Runs a Node program to its end, with `input` on its standard input. */
export const runProgram = (
  entry: string,
  args: readonly string[],
  env: { readonly [name: string]: string },
  input = "",
): Promise<Finished> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });

/** Makes a socket file nothing listens on: its server is killed before it can remove it. */
export const staleSocket = async (path: string): Promise<void> => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      'require("node:net").createServer().listen(process.argv[1], () => console.log("ready"))',
      path,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise((resolve) => child.stdout.once("data", resolve));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
};

export type Client = {
  readonly socket: Socket;
  readonly send: (text: string) => void;
  /** The next line, or null once the connection has ended. */
  readonly nextLine: () => Promise<string | null>;
};

/** Connects to the socket at `path` and reads its lines. */
export const connectClient = (path: string): Promise<Client> =>
  new Promise((resolve, reject) => {
    const lines = inbox<string>();
    let state = INITIAL_LINE_STATE;
    const socket = createConnection(path);
    socket.on("data", (chunk: Uint8Array) => {
      const split = splitLines(state, chunk, 64 * 1024 * 1024);
      state = split.state;
      split.lines.forEach(lines.push);
    });
    socket.on("close", () => lines.end());
    socket.on("error", reject);
    socket.once("connect", () =>
      resolve({
        socket,
        send: (text) => socket.write(text),
        nextLine: lines.next,
      }),
    );
  });
