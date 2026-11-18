// The command as a process, against a socket the test serves in the
// host's place: it records each request line and answers with a canned
// response line.

import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { VERSION } from "../../src/command/version.ts";
import {
  encode,
  failure,
  type Response,
  type SetSuccess,
} from "../../src/protocol/index.ts";
import {
  COMMAND_ENTRY,
  type Finished,
  runProgram,
  shortTemporaryFolder,
  staleSocket,
} from "../host/processes.ts";

const setSuccess: SetSuccess = {
  protocol: 1,
  ok: true,
  command: "set",
  group: { title: "Reading", windowId: 7, created: false },
  opened: 2,
  closed: 1,
  kept: [],
  unchecked: 0,
  loading: 0,
};

describe("the command as a process", () => {
  let folder = "";
  let socket = "";
  let server: Server | null = null;
  let requests: unknown[] = [];

  /** Serves the socket, answering every request line with `answer`, or closing for null. */
  const serve = (answer: string | null): Promise<void> =>
    new Promise((resolve) => {
      server = createServer((connection) => {
        let buffered = "";
        connection.on("data", (chunk: Buffer) => {
          buffered += chunk.toString("utf8");
          const end = buffered.indexOf("\n");
          if (end !== -1) {
            requests.push(JSON.parse(buffered.slice(0, end)));
            if (answer === null) {
              connection.destroy();
            } else {
              connection.write(answer);
            }
          }
        });
        connection.on("error", () => undefined);
      });
      server.listen(socket, resolve);
    });

  const respond = (response: Response): Promise<void> =>
    serve(encode(response));

  const command = (args: readonly string[], input = ""): Promise<Finished> =>
    runProgram(
      COMMAND_ENTRY,
      args,
      { DECLARATIVE_TAB_GROUPS_SOCKET: socket },
      input,
    );

  beforeEach(async () => {
    folder = await shortTemporaryFolder();
    socket = join(folder, "h.sock");
    requests = [];
  });

  afterEach(async () => {
    await new Promise<void>((resolve) =>
      server === null ? resolve() : server.close(() => resolve()),
    );
    server = null;
    await rm(folder, { recursive: true, force: true });
  });

  it("sets a group from its arguments and reports it", async () => {
    await respond(setSuccess);
    assert.deepEqual(
      await command([
        "set",
        "--group",
        "Reading",
        "--color",
        "blue",
        "--no-status-page",
        "https://a.example/",
        "https://b.example/",
      ]),
      {
        status: 0,
        stdout: '"Reading" in window 7: opened 2, closed 1\n',
        stderr: "",
      },
    );
    assert.deepEqual(requests, [
      {
        protocol: 1,
        command: "set",
        group: "Reading",
        urls: ["https://a.example/", "https://b.example/"],
        color: "blue",
        statusPage: false,
      },
    ]);
  });

  it("reads the URLs from standard input with --urls-from -, and prints the line as received with --json", async () => {
    const received = `${JSON.stringify(setSuccess, null, 0)}\n`;
    await serve(received);
    const finished = await command(
      [
        "set",
        "--group",
        "Reading",
        "--status-page",
        "--urls-from",
        "-",
        "--json",
      ],
      "https://a.example/\n\nhttps://b.example/\n",
    );
    assert.deepEqual(finished, { status: 0, stdout: received, stderr: "" });
    assert.deepEqual(requests, [
      {
        protocol: 1,
        command: "set",
        group: "Reading",
        urls: ["https://a.example/", "https://b.example/"],
        statusPage: true,
      },
    ]);
  });

  it("reads the URLs from a file with --urls-from", async () => {
    await respond(setSuccess);
    const file = join(folder, "urls");
    await writeFile(file, "https://a.example/\n");
    assert.equal(
      (await command(["set", "--group", "g", "--urls-from", file])).status,
      0,
    );
    assert.deepEqual(requests, [
      { protocol: 1, command: "set", group: "g", urls: ["https://a.example/"] },
    ]);
  });

  it("exits 3 when set kept a tab with an unsubmitted form", async () => {
    await respond({
      ...setSuccess,
      kept: [{ url: "https://example.org/compose", title: "New message" }],
    });
    const finished = await command(["set", "--group", "Reading"]);
    assert.equal(finished.status, 3);
    assert.match(
      finished.stdout,
      /\n {2}New message {2}https:\/\/example\.org\/compose\n/,
    );
  });

  it("prints a group's URLs one per line", async () => {
    await respond({
      protocol: 1,
      ok: true,
      command: "get",
      group: { title: "Reading", windowId: 7 },
      tabs: [
        { url: "https://a.example/", title: "A" },
        { url: "https://b.example/", title: "B" },
      ],
    });
    assert.deepEqual(await command(["get", "--group", "Reading"]), {
      status: 0,
      stdout: "https://a.example/\nhttps://b.example/\n",
      stderr: "",
    });
    assert.deepEqual(requests, [
      { protocol: 1, command: "get", group: "Reading" },
    ]);
  });

  it("prints the versions", async () => {
    await respond({
      protocol: 1,
      ok: true,
      command: "status",
      extension: "0.1.0",
      chrome: "142.0.7444.176",
    });
    assert.deepEqual(await command(["status"]), {
      status: 0,
      stdout: `declarative-tab-groups ${VERSION}\nextension 0.1.0\nGoogle Chrome 142.0.7444.176\n`,
      stderr: "",
    });
  });

  it("exits 1 on a failure response, with its code and message on standard error", async () => {
    await respond(failure("no-group", 'no tab group is titled "Reading"'));
    assert.deepEqual(await command(["get", "--group", "Reading"]), {
      status: 1,
      stdout: "",
      stderr:
        'declarative-tab-groups: no-group: no tab group is titled "Reading"\n',
    });
  });

  it("exits 4 on the failure not-connected", async () => {
    await respond(failure("not-connected", "Chrome is not running"));
    const finished = await command(["status"]);
    assert.equal(finished.status, 4);
    assert.match(finished.stderr, /not-connected: Chrome is not running/);
  });

  it("exits 4 when no socket exists", async () => {
    const finished = await command(["status"]);
    assert.equal(finished.status, 4);
    assert.match(
      finished.stderr,
      /^declarative-tab-groups: not-connected: no host answers on /,
    );
  });

  it("exits 4 when the socket refuses the connection", async () => {
    await staleSocket(socket);
    const finished = await command(["status", "--json"]);
    assert.equal(finished.status, 4);
    assert.match(
      finished.stdout,
      /^\{"protocol":1,"ok":false,"error":\{"code":"not-connected"/,
    );
  });

  it("exits 4 when the host closes the connection without answering", async () => {
    await serve(null);
    const finished = await command(["status"]);
    assert.equal(finished.status, 4);
    assert.match(finished.stderr, /closed the connection without answering/);
  });

  it("exits 2 on each usage error, without connecting", async () => {
    await respond(setSuccess);
    for (const args of [
      [],
      ["open"],
      ["set"],
      ["set", "--group", "g", "--color", "mauve"],
      ["set", "--group", "g", "--status-page", "--no-status-page"],
      ["set", "--group", "g", "--urls-from", "-", "https://a.example/"],
      ["set", "--group", "g", "ftp://a.example/"],
      ["set", "--group", " "],
      ["set", "--group", "g", "--urls-from", join(folder, "missing")],
      ["get"],
      ["status", "extra"],
    ]) {
      const finished = await command(args);
      assert.equal(finished.status, 2, JSON.stringify(args));
      assert.equal(finished.stdout, "");
      assert.match(
        finished.stderr,
        /^declarative-tab-groups: .*\nRun "declarative-tab-groups( [a-z]+)? --help" for usage\.\n$/,
      );
    }
    assert.deepEqual(requests, []);
  });

  it("exits 2 when the socket path is too long", async () => {
    const finished = await runProgram(COMMAND_ENTRY, ["status"], {
      DECLARATIVE_TAB_GROUPS_SOCKET: `/${"x".repeat(120)}`,
    });
    assert.equal(finished.status, 2);
    assert.match(finished.stderr, /holds at most 103/);
  });

  it("prints help and the version, exiting 0", async () => {
    for (const args of [
      ["--help"],
      ["set", "--help"],
      ["get", "--help"],
      ["status", "--help"],
    ]) {
      const finished = await command(args);
      assert.equal(finished.status, 0);
      assert.match(finished.stdout, /\nExample:\n/);
    }
    assert.deepEqual(await command(["--version"]), {
      status: 0,
      stdout: `declarative-tab-groups ${VERSION}\n`,
      stderr: "",
    });
  });
});
