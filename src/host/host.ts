// The host's edge: it checks the browser and the caller, claims and binds
// the socket as `claim.ts` lays out, and then turns standard input, the
// socket's connections and timers into the router's events and carries
// out the router's effects. Standard output carries native messages only;
// every diagnostic goes to standard error.

import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rename, unlink } from "node:fs/promises";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { basename, dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";

import { type Hello, PROTOCOL_VERSION } from "../protocol/index.ts";
import {
  type Bind,
  claimSocket,
  type Probe,
  releaseSocket,
  type SocketEdge,
} from "./claim.ts";
import {
  type ByteOrder,
  decodeFrames,
  encodeFrame,
  INITIAL_FRAME_STATE,
} from "./frame.ts";
import { isExtensionOrigin, isGoogleChromeExecutable } from "./guard.ts";
import {
  type ClientId,
  INITIAL_ROUTER_STATE,
  REQUEST_TIMEOUT_MS,
  route,
  type RouterEffect,
  type RouterEvent,
} from "./router.ts";
import {
  type Environment,
  folderProblem,
  socketFolder,
  socketPath,
} from "./socket-path.ts";

/** Everything the host takes from its process, so a test can supply it. */
export type HostIo = {
  /** The arguments after the program's path: Chrome passes the caller's origin first. */
  readonly args: readonly string[];
  readonly env: Environment;
  readonly uid: number;
  readonly byteOrder: ByteOrder;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  /** The executable path of the host's parent process, or null when it cannot be found. */
  readonly parentExecutable: () => Promise<string | null>;
  /** Calls the listener when the process is told to stop, by `SIGTERM` or `SIGINT`. */
  readonly onStopSignal: (listener: () => void) => void;
  /** How long a request may wait for the extension before it is answered `internal`. */
  readonly requestTimeoutMs: number;
};

/** The process's own standard streams, environment and signals, with the given parent lookup. */
export const processIo = (
  parentExecutable: () => Promise<string | null>,
  byteOrder: ByteOrder,
  requestTimeoutMs: number = REQUEST_TIMEOUT_MS,
): HostIo => ({
  requestTimeoutMs,
  args: process.argv.slice(2),
  env: process.env,
  uid: process.getuid?.() ?? -1,
  byteOrder,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  parentExecutable,
  onStopSignal: (listener) => {
    process.on("SIGTERM", listener);
    process.on("SIGINT", listener);
  },
});

/** How long, once stopping, the host waits for its clients to close. */
const CLOSE_GRACE_MS = 1_000;

/** How long the host waits for an existing socket to accept a connection. */
const PROBE_MS = 2_000;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const codeOf = (error: unknown): string | undefined =>
  (error as { readonly code?: unknown }).code === undefined
    ? undefined
    : String((error as { readonly code?: unknown }).code);

/** Starts listening on the path, giving the error it fails with, if any. */
const listen = (server: Server, path: string): Promise<unknown> =>
  new Promise((resolve) => {
    const onError = (error: unknown): void => {
      server.off("listening", onListening);
      resolve(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve(null);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });

/**
 * Whether something answers on the socket, the socket is stale, or it has
 * gone. Anything else counts as answered, so a doubt never removes a file.
 */
const probe = (path: string): Promise<Probe> =>
  new Promise((resolve) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("answered");
    }, PROBE_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve("answered");
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      const code = codeOf(error);
      resolve(
        code === "ECONNREFUSED"
          ? "refused"
          : code === "ENOENT"
            ? "gone"
            : "answered",
      );
    });
  });

const removeIfPresent = (path: string): Promise<void> =>
  unlink(path).catch((error: unknown) => {
    if (codeOf(error) !== "ENOENT") {
      throw error;
    }
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

/** A claim's name: the socket's name, `.`, 8 hex digits and `.claim`. */
const CLAIM_NAME = /^\.[0-9a-f]{8}\.claim$/;

/** A claim's name while it is made, before it listens and is renamed. */
const TEMPORARY_NAME = /^\.[0-9a-f]{8}\.new$/;

/**
 * The sockets in the socket's folder whose names, after the socket's, match
 * `pattern`. Every claim is a socket from the moment its name appears, so
 * a file with such a name that is not a socket was made by no host: it is
 * no claim, and it is left alone, as is every file the host did not make.
 */
const socketsNamed = async (
  path: string,
  pattern: RegExp,
): Promise<readonly string[]> => {
  const folder = dirname(path);
  const name = basename(path);
  const named = (await readdir(folder))
    .filter(
      (entry) =>
        entry.startsWith(name) && pattern.test(entry.slice(name.length)),
    )
    .map((entry) => join(folder, entry));
  const kinds = await Promise.all(
    named.map((entry) =>
      lstat(entry).then(
        (status) => status.isSocket(),
        () => false,
      ),
    ),
  );
  return named.filter((_, index) => kinds[index]);
};

/**
 * Removes the temporary claims of hosts that stopped before renaming them,
 * under the rule for claims: one that refuses a connection is removed. A
 * host whose temporary claim is removed between its bind and its listen
 * fails to rename it, and refuses to serve.
 */
const removeStaleTemporaries = async (path: string): Promise<void> => {
  for (const temporary of await socketsNamed(path, TEMPORARY_NAME)) {
    if ((await probe(temporary)) === "refused") {
      await removeIfPresent(temporary);
    }
  }
};

/**
 * The claim's steps on the file system, for the socket at `path` served by
 * `server`. A claim listens under a temporary name and is then renamed, so
 * it is visible only once it answers.
 */
const socketEdge = (path: string, server: Server): SocketEdge => {
  const token = randomBytes(4).toString("hex");
  const claim = `${path}.${token}.claim`;
  const claimServer = createServer((connection) => connection.destroy());
  return {
    createClaim: async () => {
      await removeStaleTemporaries(path);
      const temporary = `${path}.${token}.new`;
      const error = await listen(claimServer, temporary);
      if (error !== null) {
        throw error;
      }
      await rename(temporary, claim);
      return claim;
    },
    listClaims: () => socketsNamed(path, CLAIM_NAME),
    probeClaim: probe,
    removeClaim: removeIfPresent,
    closeClaim: async () => {
      await closeServer(claimServer);
      await removeIfPresent(claim);
    },
    inspectSocket: async () => {
      const status = await lstat(path).catch(() => null);
      return status === null
        ? "absent"
        : status.isSocket()
          ? "socket"
          : "other";
    },
    probeSocket: () => probe(path),
    removeSocket: () => removeIfPresent(path),
    bindSocket: async () => {
      const error = await listen(server, path);
      return error === null
        ? { kind: "bound" }
        : codeOf(error) === "EADDRINUSE"
          ? { kind: "in-use" }
          : { kind: "problem", message: messageOf(error) };
    },
    // The server stops listening, and its path goes, at once; its
    // connections still open close on their own time, not the claim's.
    closeSocket: async () => {
      server.close();
    },
  };
};

/** Creates the socket's folder if missing, and checks it is only the user's. */
const prepareFolder = async (
  folder: string,
  uid: number,
): Promise<string | null> => {
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const status = await lstat(folder);
    return folderProblem(
      folder,
      {
        isDirectory: status.isDirectory(),
        isSymbolicLink: status.isSymbolicLink(),
        uid: status.uid,
        mode: status.mode,
      },
      uid,
    );
  } catch (error) {
    return `cannot create ${folder}: ${messageOf(error)}`;
  }
};

/**
 * Runs the host and resolves to its exit status once it has stopped and
 * its output has been written. It serves only when its parent is Google
 * Chrome and its caller is this tool's extension.
 */
export const run = async (io: HostIo): Promise<number> => {
  const report = (message: string): void => {
    io.stderr.write(`declarative-tab-groups-host: ${message}\n`);
  };
  const writeFrame = (message: unknown): Promise<void> =>
    new Promise((resolve) => {
      io.stdout.write(encodeFrame(message, io.byteOrder), () => resolve());
    });
  const refuse = async (refused: "not-google-chrome" | "socket-in-use") => {
    const hello: Hello = { hello: { refused } };
    await writeFrame(hello);
    return 1;
  };

  const parent = await io.parentExecutable().catch(() => null);
  if (!isGoogleChromeExecutable(parent)) {
    report(
      `refusing to serve: the browser that started the host is not Google Chrome (${parent ?? "unknown"})`,
    );
    return refuse("not-google-chrome");
  }
  if (!isExtensionOrigin(io.args[0])) {
    report(
      `refusing to serve: started for ${JSON.stringify(io.args[0] ?? "")}, not this tool's extension`,
    );
    return 1;
  }
  const path = socketPath(io.env);
  if (!path.ok) {
    report(path.error);
    return 1;
  }
  const problem = await prepareFolder(socketFolder(path.value), io.uid);
  if (problem !== null) {
    report(`refusing to serve: ${problem}`);
    return 1;
  }

  const server = createServer({ allowHalfOpen: true });
  const edge = socketEdge(path.value, server);
  const bound = await claimSocket(edge).catch(
    async (error: unknown): Promise<Bind> => {
      await edge.closeClaim().catch(() => undefined);
      return { kind: "problem", message: messageOf(error) };
    },
  );
  if (bound.kind === "in-use") {
    report(`another host serves ${path.value}`);
    return refuse("socket-in-use");
  }
  if (bound.kind === "problem") {
    report(`cannot listen on ${path.value}: ${bound.message}`);
    return 1;
  }
  try {
    await chmod(path.value, 0o600);
  } catch (error) {
    report(`cannot make ${path.value} private: ${messageOf(error)}`);
    await releaseSocket(edge);
    return 1;
  }

  let state = INITIAL_ROUTER_STATE;
  let frames = INITIAL_FRAME_STATE;
  let exitStatus = 0;
  let nextClient: ClientId = 1;
  const sockets = new Map<ClientId, Socket>();
  const timers = new Map<string, NodeJS.Timeout>();
  let stopped = (): void => undefined;
  const stopping = new Promise<void>((resolve) => {
    stopped = resolve;
  });

  const perform = (effect: RouterEffect): void => {
    switch (effect.kind) {
      case "write-frame":
        void writeFrame(effect.message);
        return;
      case "write-line":
        sockets.get(effect.client)?.write(effect.line);
        return;
      case "close-client":
        sockets.get(effect.client)?.end();
        return;
      case "start-timer":
        timers.set(
          effect.id,
          setTimeout(() => {
            timers.delete(effect.id);
            dispatch({
              kind: "timeout",
              id: effect.id,
              afterMs: io.requestTimeoutMs,
            });
          }, io.requestTimeoutMs),
        );
        return;
      case "cancel-timer":
        clearTimeout(timers.get(effect.id));
        timers.delete(effect.id);
        return;
      case "log":
        report(effect.message);
        return;
      case "stop":
        stopped();
        return;
    }
  };

  const dispatch = (event: RouterEvent): void => {
    const next = route(state, event);
    state = next.state;
    next.effects.forEach(perform);
  };

  server.on("connection", (socket) => {
    const client = nextClient;
    nextClient += 1;
    sockets.set(client, socket);
    dispatch({ kind: "client-connected", client });
    socket.on("data", (chunk: Uint8Array) =>
      dispatch({ kind: "data", client, chunk }),
    );
    socket.on("end", () => dispatch({ kind: "client-ended", client }));
    socket.on("error", () => undefined);
    socket.on("close", () => {
      sockets.delete(client);
      dispatch({ kind: "client-closed", client });
    });
  });

  io.stdin.on("data", (chunk: Uint8Array) => {
    const decoded = decodeFrames(frames, chunk, io.byteOrder);
    frames = decoded.state;
    decoded.messages.forEach((text) =>
      dispatch({ kind: "extension-message", text }),
    );
    if (decoded.error !== null) {
      report(decoded.error);
      exitStatus = 1;
      dispatch({ kind: "port-closed" });
    }
  });
  io.stdin.on("end", () => dispatch({ kind: "port-closed" }));
  io.stdin.on("error", () => dispatch({ kind: "port-closed" }));
  io.stdout.on("error", () => dispatch({ kind: "port-closed" }));
  io.onStopSignal(() => dispatch({ kind: "port-closed" }));

  await writeFrame({ hello: { protocol: PROTOCOL_VERSION } } satisfies Hello);
  await stopping;

  io.stdin.pause();
  timers.forEach((timer) => clearTimeout(timer));
  // Closing the socket removes its path, and only then the claim goes, both
  // before the clients' grace, so a host started meanwhile may serve.
  await releaseSocket(edge);
  await Promise.race([
    Promise.all(
      [...sockets.values()].map(
        (socket) =>
          new Promise<void>((resolve) => {
            if (socket.destroyed) {
              resolve();
            } else {
              socket.once("close", () => resolve());
            }
          }),
      ),
    ),
    new Promise((resolve) => setTimeout(resolve, CLOSE_GRACE_MS)),
  ]);
  sockets.forEach((socket) => socket.destroy());
  await new Promise<void>((resolve) => io.stdout.write("", () => resolve()));
  return exitStatus;
};
