// The host as a process: the test stands in for Chrome on its pipes and for
// a client on its socket. The launcher answers the parent lookup with
// Google Chrome's path; `entry-point.test.ts` covers the real entry point.

import assert from "node:assert/strict";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { EXTENSION_ORIGIN } from "../../src/host/guard.ts";
import {
  encode,
  failure,
  MAX_REQUEST_LINE_BYTES,
  type Response,
} from "../../src/protocol/index.ts";
import {
  connectClient,
  type HostProcess,
  shortTemporaryFolder,
  staleSocket,
  startHost,
} from "./processes.ts";

const status = '{"protocol":1,"command":"status"}\n';

const statusResponse = (chrome: string): Response => ({
  protocol: 1,
  ok: true,
  command: "status",
  extension: "0.1.0",
  chrome,
});

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

describe("the host as a process", () => {
  let folder = "";
  let socket = "";
  const hosts: HostProcess[] = [];
  const start = (
    options: Parameters<typeof startHost>[1] = {},
    path: string = socket,
  ): HostProcess => {
    const host = startHost(path, options);
    hosts.push(host);
    return host;
  };

  beforeEach(async () => {
    folder = await shortTemporaryFolder();
    socket = join(folder, "d", "h.sock");
  });

  afterEach(async () => {
    hosts.splice(0).forEach((host) => host.child.kill("SIGKILL"));
    await rm(folder, { recursive: true, force: true });
  });

  it("says hello once its socket is bound, in a folder and socket only the user's", async () => {
    const host = start();
    assert.deepEqual(await host.nextMessage(), { hello: { protocol: 1 } });
    assert.equal((await stat(join(folder, "d"))).mode & 0o777, 0o700);
    assert.equal((await stat(socket)).mode & 0o777, 0o600);
    host.closePort();
    assert.equal(await host.exited, 0);
  });

  it("relays a request to the extension and its response to the client", async () => {
    const host = start();
    await host.nextMessage();
    const client = await connectClient(socket);
    client.send(status);
    const envelope = (await host.nextMessage()) as { id: string };
    assert.deepEqual(envelope, {
      id: envelope.id,
      request: { protocol: 1, command: "status" },
    });
    const response = statusResponse("142.0");
    host.send({ id: envelope.id, response });
    assert.equal(await client.nextLine(), encode(response).trimEnd());
    client.socket.destroy();
  });

  it("answers an invalid line itself, without sending it to the extension", async () => {
    const host = start();
    await host.nextMessage();
    const client = await connectClient(socket);
    client.send('{"protocol":1,"command":"get"}\n');
    assert.equal(
      await client.nextLine(),
      encode(failure("invalid-request", 'missing field "group"')).trimEnd(),
    );
    client.send(status);
    assert.deepEqual(
      ((await host.nextMessage()) as { request: unknown }).request,
      { protocol: 1, command: "status" },
      "the next message on the port is the valid request",
    );
    client.socket.destroy();
  });

  it("delivers responses in request order when the extension answers out of order", async () => {
    const host = start();
    await host.nextMessage();
    const client = await connectClient(socket);
    client.send(status + status);
    const first = (await host.nextMessage()) as { id: string };
    const second = (await host.nextMessage()) as { id: string };
    host.send({ id: second.id, response: statusResponse("second") });
    host.send({ id: first.id, response: statusResponse("first") });
    assert.equal(
      await client.nextLine(),
      encode(statusResponse("first")).trimEnd(),
    );
    assert.equal(
      await client.nextLine(),
      encode(statusResponse("second")).trimEnd(),
    );
    client.socket.destroy();
  });

  it("answers a line over the bound with invalid-request and closes the connection", async () => {
    const host = start();
    await host.nextMessage();
    const client = await connectClient(socket);
    client.send("x".repeat(MAX_REQUEST_LINE_BYTES + 1));
    assert.equal(
      await client.nextLine(),
      encode(
        failure(
          "invalid-request",
          `the request line is longer than ${MAX_REQUEST_LINE_BYTES} bytes`,
        ),
      ).trimEnd(),
    );
    assert.equal(
      await client.nextLine(),
      null,
      "the host closed the connection",
    );
  });

  it("refuses with socket-in-use while another host serves the socket", async () => {
    const first = start();
    await first.nextMessage();
    const second = start();
    assert.deepEqual(await second.nextMessage(), {
      hello: { refused: "socket-in-use" },
    });
    assert.notEqual(await second.exited, 0);
    const client = await connectClient(socket);
    client.socket.destroy();
  });

  it("replaces a stale socket", async () => {
    await mkdir(join(folder, "d"), { mode: 0o700 });
    await staleSocket(socket);
    assert.equal(await exists(socket), true);
    const host = start();
    assert.deepEqual(await host.nextMessage(), { hello: { protocol: 1 } });
    const client = await connectClient(socket);
    client.socket.destroy();
  });

  it("answers pending requests not-connected when Chrome closes the port, removes its socket and exits 0", async () => {
    const host = start();
    await host.nextMessage();
    const client = await connectClient(socket);
    client.send(status);
    await host.nextMessage();
    host.closePort();
    assert.equal(
      await client.nextLine(),
      encode(
        failure(
          "not-connected",
          "Chrome closed the connection to the extension before it answered",
        ),
      ).trimEnd(),
    );
    assert.equal(await client.nextLine(), null);
    assert.equal(await host.exited, 0);
    assert.equal(await exists(socket), false);
  });

  it("ends the same way on SIGTERM", async () => {
    const host = start();
    await host.nextMessage();
    const client = await connectClient(socket);
    client.send(status);
    await host.nextMessage();
    host.child.kill("SIGTERM");
    assert.match((await client.nextLine()) ?? "", /"code":"not-connected"/);
    assert.equal(await host.exited, 0);
    assert.equal(await exists(socket), false);
  });

  it("refuses to serve from a folder others can enter", async () => {
    await mkdir(join(folder, "d"));
    await chmod(join(folder, "d"), 0o755);
    const host = start();
    assert.equal(await host.nextMessage(), null);
    assert.notEqual(await host.exited, 0);
    assert.match(host.stderr(), /can be entered by other users/);
    assert.equal(await exists(socket), false);
  });

  it("refuses a socket path too long for macOS, saying so", async () => {
    const host = start({}, join(folder, "x".repeat(120), "h.sock"));
    assert.equal(await host.nextMessage(), null);
    assert.notEqual(await host.exited, 0);
    assert.match(
      host.stderr(),
      /a Unix socket path on macOS holds at most 103/,
    );
  });

  it("refuses a caller other than this tool's extension, without serving", async () => {
    const host = start({
      args: ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"],
    });
    assert.equal(await host.nextMessage(), null);
    assert.notEqual(await host.exited, 0);
    assert.match(host.stderr(), /not this tool's extension/);
    assert.equal(await exists(join(folder, "d")), false);
  });

  it("lets at most one of three hosts started together serve, beside a stale socket", async () => {
    for (let round = 0; round < 5; round += 1) {
      await mkdir(join(folder, "d"), { mode: 0o700, recursive: true });
      await staleSocket(socket);
      const started = [start(), start(), start()];
      const hellos = await Promise.all(
        started.map((host) => host.nextMessage()),
      );
      const servers = started.filter(
        (_, index) =>
          JSON.stringify(hellos[index]) === '{"hello":{"protocol":1}}',
      );
      assert.ok(
        servers.length <= 1,
        `round ${round}: ${JSON.stringify(hellos)}`,
      );
      const losers = started.filter((host) => !servers.includes(host));
      hellos
        .filter((_, index) => !servers.includes(started[index] as HostProcess))
        .forEach((hello) =>
          assert.deepEqual(hello, { hello: { refused: "socket-in-use" } }),
        );
      for (const loser of losers) {
        assert.notEqual(await loser.exited, 0);
      }
      const [server] = servers;
      if (server !== undefined) {
        const entries = (await readdir(join(folder, "d"))).toSorted();
        assert.equal(entries.length, 2, "the socket and the server's claim");
        assert.equal(entries[0], "h.sock");
        assert.match(entries[1] ?? "", /^h\.sock\.[0-9a-f]{8}\.claim$/);
        const client = await connectClient(socket);
        client.send(status);
        const envelope = (await server.nextMessage()) as { id: string };
        server.send({ id: envelope.id, response: statusResponse("142.0") });
        assert.equal(
          await client.nextLine(),
          encode(statusResponse("142.0")).trimEnd(),
        );
        client.socket.destroy();
        server.closePort();
        assert.equal(await server.exited, 0);
        assert.deepEqual(await readdir(join(folder, "d")), []);
      }
      await rm(join(folder, "d"), { recursive: true, force: true });
    }
  });

  it("refuses a file at the socket's path that is not a socket, and keeps it", async () => {
    await mkdir(join(folder, "d"), { mode: 0o700 });
    await writeFile(socket, "kept");
    const host = start();
    assert.equal(await host.nextMessage(), null);
    assert.notEqual(await host.exited, 0);
    assert.match(host.stderr(), /exists and is not a socket/);
    assert.equal(await readFile(socket, "utf8"), "kept");
    assert.deepEqual(await readdir(join(folder, "d")), ["h.sock"]);
  });

  it("lets go of its claim before its clients' grace, so a host started then serves", async () => {
    const first = start();
    await first.nextMessage();
    // A client that never ends its side, so the host waits out its grace.
    const held = createConnection({ path: socket, allowHalfOpen: true });
    held.on("error", () => undefined);
    await once(held, "connect");
    let firstExited = false;
    void first.exited.then(() => {
      firstExited = true;
    });
    first.closePort();
    while ((await readdir(join(folder, "d"))).length > 0) {
      await delay(10);
    }
    await delay(250);
    assert.equal(
      firstExited,
      false,
      "the first host still waits on its client",
    );
    const second = start();
    assert.deepEqual(await second.nextMessage(), { hello: { protocol: 1 } });
    held.destroy();
    assert.equal(await first.exited, 0);
    second.closePort();
    assert.equal(await second.exited, 0);
  });

  it("removes the temporary claim of a host killed before renaming it, and serves", async () => {
    await mkdir(join(folder, "d"), { mode: 0o700 });
    const leftover = `${socket}.0123abcd.new`;
    await staleSocket(leftover);
    const host = start();
    assert.deepEqual(await host.nextMessage(), { hello: { protocol: 1 } });
    assert.equal(await exists(leftover), false);
    host.closePort();
    assert.equal(await host.exited, 0);
    assert.deepEqual(await readdir(join(folder, "d")), []);
  });

  it("takes a file with a claim's name that is not a socket for no claim, and keeps it", async () => {
    await mkdir(join(folder, "d"), { mode: 0o700 });
    const impostor = `${socket}.0123abcd.claim`;
    await writeFile(impostor, "kept");
    const host = start();
    assert.deepEqual(await host.nextMessage(), { hello: { protocol: 1 } });
    host.closePort();
    assert.equal(await host.exited, 0);
    assert.equal(await readFile(impostor, "utf8"), "kept");
  });

  it("refuses a socket folder that is a link, even to a private folder", async () => {
    await mkdir(join(folder, "r"), { mode: 0o700 });
    await symlink(join(folder, "r"), join(folder, "d"));
    const host = start();
    assert.equal(await host.nextMessage(), null);
    assert.notEqual(await host.exited, 0);
    assert.match(host.stderr(), /is not a folder/);
  });

  it("answers internal a request the extension leaves unanswered past the timeout", async () => {
    const host = start({
      args: ["--request-timeout-ms", "200", EXTENSION_ORIGIN],
    });
    await host.nextMessage();
    const client = await connectClient(socket);
    client.send(status);
    await host.nextMessage();
    assert.equal(
      await client.nextLine(),
      encode(
        failure("internal", "the extension did not answer within 0.2 seconds"),
      ).trimEnd(),
    );
    client.socket.destroy();
  });

  it("ends as when the port closes once Chrome stops reading its output", async () => {
    const host = start();
    await host.nextMessage();
    host.child.stdout?.destroy();
    const client = await connectClient(socket);
    client.send(status);
    assert.match((await client.nextLine()) ?? "", /"code":"not-connected"/);
    assert.equal(await host.exited, 0);
    assert.equal(await exists(socket), false);
  });
});
