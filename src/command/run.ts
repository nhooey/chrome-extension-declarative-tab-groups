// The command's edge: it reads `--urls-from`, sends one request line to the
// host's socket, reads one response line, and prints. It connects once:
// it never starts Chrome or any other program, and never retries.
// `install` and `uninstall` go to their own edge, `install.ts`.

import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import type { Readable, Writable } from "node:stream";

import { encode, type Request, validateRequest } from "../protocol/index.ts";
import { MAX_FRAME_BYTES } from "../host/frame.ts";
import { INITIAL_LINE_STATE, splitLines } from "../host/lines.ts";
import { REQUEST_TIMEOUT_MS } from "../host/router.ts";
import { type Environment, socketPath } from "../host/socket-path.ts";
import { parseArguments, type RequestCommand, usageText } from "./arguments.ts";
import { runSetup, type SetupIo } from "./install.ts";
import { PROGRAM } from "./help.ts";
import {
  EXIT,
  type Outcome,
  output,
  requestFor,
  urlsFromText,
} from "./output.ts";
import { VERSION } from "./version.ts";

export type CommandIo = SetupIo & {
  /** The arguments after the program's path. */
  readonly args: readonly string[];
  readonly env: Environment;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  /** How long to wait for the response line before giving up as `not-connected`. */
  readonly deadlineMs: number;
};

/**
 * How long the command waits for its answer: the host answers every
 * request within its own 120 seconds, and the margin covers the trip.
 */
export const RESPONSE_DEADLINE_MS = REQUEST_TIMEOUT_MS + 10_000;

const write = (stream: Writable, text: string): Promise<void> =>
  text === ""
    ? Promise.resolve()
    : new Promise((resolve) => stream.write(text, () => resolve()));

const readAll = async (stream: Readable): Promise<string> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Uint8Array);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** `set`'s URLs, from its arguments, its file or standard input. */
const readUrls = async (
  command: RequestCommand,
  stdin: Readable,
): Promise<readonly string[]> => {
  if (command.command !== "set") {
    return [];
  }
  if (command.urls.kind === "arguments") {
    return command.urls.urls;
  }
  const text =
    command.urls.path === "-"
      ? await readAll(stdin)
      : await readFile(command.urls.path, "utf8");
  return urlsFromText(text);
};

/**
 * Sends the request line and reads the first response line. A connection
 * that fails, closes before a whole line, or brings no line within
 * `deadlineMs`, is `not-connected`.
 */
const exchange = (
  path: string,
  request: Request,
  deadlineMs: number,
): Promise<Outcome> =>
  new Promise((resolve) => {
    let lines = INITIAL_LINE_STATE;
    let settled = false;
    const settle = (outcome: Outcome): void => {
      if (!settled) {
        settled = true;
        clearTimeout(deadline);
        socket.destroy();
        resolve(outcome);
      }
    };
    const deadline = setTimeout(
      () =>
        settle({
          kind: "not-connected",
          message: `the host at ${path} did not answer within ${deadlineMs / 1000} seconds`,
        }),
      deadlineMs,
    );
    const socket = createConnection(path, () => {
      socket.write(encode(request));
    });
    socket.on("data", (chunk: Uint8Array) => {
      const split = splitLines(lines, chunk, MAX_FRAME_BYTES);
      lines = split.state;
      const [line] = split.lines;
      if (line !== undefined) {
        settle({ kind: "line", line });
      } else if (split.overflow) {
        settle({
          kind: "not-connected",
          message: `the host's response is longer than ${MAX_FRAME_BYTES} bytes`,
        });
      }
    });
    socket.on("error", (error) => {
      settle({
        kind: "not-connected",
        message: `no host answers on ${path}: ${messageOf(error)}`,
      });
    });
    socket.on("close", () => {
      settle({
        kind: "not-connected",
        message: `the host at ${path} closed the connection without answering`,
      });
    });
  });

/** Runs the command and resolves to its exit status once its output is written. */
export const runCommand = async (io: CommandIo): Promise<number> => {
  const invocation = parseArguments(io.args);
  switch (invocation.kind) {
    case "help":
      await write(io.stdout, invocation.text);
      return EXIT.success;
    case "version":
      await write(io.stdout, `${PROGRAM} ${VERSION}\n`);
      return EXIT.success;
    case "usage-error":
      await write(
        io.stderr,
        usageText(invocation.message, invocation.subcommand),
      );
      return EXIT.usage;
    case "run":
      break;
  }
  const { command } = invocation;
  if (command.command === "install" || command.command === "uninstall") {
    const result = await runSetup(command, io);
    await write(io.stdout, result.stdout);
    await write(io.stderr, result.stderr);
    return result.status;
  }
  const subcommand = command.command;
  const urls = await readUrls(command, io.stdin).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error: messageOf(error) }),
  );
  if (!urls.ok) {
    await write(
      io.stderr,
      usageText(`cannot read the URLs: ${urls.error}`, subcommand),
    );
    return EXIT.usage;
  }
  const request = validateRequest(requestFor(command, urls.value));
  if (!request.ok) {
    await write(io.stderr, usageText(request.error.error.message, subcommand));
    return EXIT.usage;
  }
  const path = socketPath(io.env);
  if (!path.ok) {
    await write(io.stderr, usageText(path.error, subcommand));
    return EXIT.usage;
  }
  const result = output(
    command,
    await exchange(path.value, request.value, io.deadlineMs),
    VERSION,
  );
  await write(io.stdout, result.stdout);
  await write(io.stderr, result.stderr);
  return result.status;
};
