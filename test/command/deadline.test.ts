// The command gives up on a host that accepts and never answers: run in
// this process with a short deadline, against a listener that stays silent.

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import { MAIN_HELP, STATUS_HELP } from "../../src/command/help.ts";
import { RESPONSE_DEADLINE_MS, runCommand } from "../../src/command/run.ts";
import { REQUEST_TIMEOUT_MS } from "../../src/host/router.ts";
import { shortTemporaryFolder } from "../host/processes.ts";

const collect = (stream: PassThrough): (() => string) => {
  let text = "";
  stream.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  return () => text;
};

describe("the command's deadline", () => {
  it("outlasts the host's own timeout, and --help states it", () => {
    assert.ok(RESPONSE_DEADLINE_MS > REQUEST_TIMEOUT_MS);
    const seconds = `${RESPONSE_DEADLINE_MS / 1000}`;
    assert.match(MAIN_HELP, new RegExp(`at most ${seconds}\\s+seconds`));
    assert.match(STATUS_HELP, new RegExp(`within ${seconds}\\s+seconds`));
  });

  it("settles as not-connected, exiting 4, when the host never answers", async () => {
    const folder = await shortTemporaryFolder();
    const socket = join(folder, "h.sock");
    const connections: Socket[] = [];
    const server = createServer((connection) => connections.push(connection));
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const out = collect(stdout);
      const err = collect(stderr);
      const started = Date.now();
      const status = await runCommand({
        args: ["status"],
        env: { DECLARATIVE_TAB_GROUPS_SOCKET: socket },
        stdin: new PassThrough(),
        stdout,
        stderr,
        deadlineMs: 200,
      });
      assert.equal(status, 4);
      assert.ok(Date.now() - started >= 200);
      assert.equal(out(), "");
      assert.equal(
        err(),
        `declarative-tab-groups: not-connected: the host at ${socket} did not answer within 0.2 seconds\n`,
      );
      assert.equal(
        connections.length,
        1,
        "it connected once, and never retried",
      );
    } finally {
      connections.forEach((connection) => connection.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(folder, { recursive: true, force: true });
    }
  });
});
