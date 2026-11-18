import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  folderProblem,
  MAX_SOCKET_PATH_BYTES,
  socketFolder,
  socketPath,
} from "../../src/host/socket-path.ts";

const ok = (value: string) => ({ ok: true, value });

describe("socketPath", () => {
  it("is DECLARATIVE_TAB_GROUPS_SOCKET when that is set", () => {
    assert.deepEqual(
      socketPath({
        DECLARATIVE_TAB_GROUPS_SOCKET: "/run/x.sock",
        XDG_STATE_HOME: "/state",
        HOME: "/home/a",
      }),
      ok("/run/x.sock"),
    );
  });

  it("is under XDG_STATE_HOME when that is set", () => {
    assert.deepEqual(
      socketPath({ XDG_STATE_HOME: "/state", HOME: "/home/a" }),
      ok("/state/declarative-tab-groups/host.sock"),
    );
  });

  it("is under ~/.local/state otherwise, an empty variable counting as unset", () => {
    const expected = ok(
      "/home/a/.local/state/declarative-tab-groups/host.sock",
    );
    assert.deepEqual(socketPath({ HOME: "/home/a" }), expected);
    assert.deepEqual(
      socketPath({
        DECLARATIVE_TAB_GROUPS_SOCKET: "",
        XDG_STATE_HOME: "",
        HOME: "/home/a",
      }),
      expected,
    );
  });

  it("ignores a relative XDG_STATE_HOME, as the XDG specification says", () => {
    assert.deepEqual(
      socketPath({ XDG_STATE_HOME: "state", HOME: "/home/a" }),
      ok("/home/a/.local/state/declarative-tab-groups/host.sock"),
    );
  });

  it("refuses a relative DECLARATIVE_TAB_GROUPS_SOCKET and a missing HOME", () => {
    assert.equal(
      socketPath({ DECLARATIVE_TAB_GROUPS_SOCKET: "x.sock", HOME: "/h" }).ok,
      false,
    );
    assert.equal(socketPath({}).ok, false);
  });

  it("refuses a path that leaves no room for a claim in a Unix socket's, naming its length", () => {
    assert.equal(MAX_SOCKET_PATH_BYTES, 88);
    const longest = `/${"a".repeat(MAX_SOCKET_PATH_BYTES - 1)}`;
    assert.deepEqual(
      socketPath({ DECLARATIVE_TAB_GROUPS_SOCKET: longest }),
      ok(longest),
    );
    const result = socketPath({ DECLARATIVE_TAB_GROUPS_SOCKET: `${longest}b` });
    assert.equal(result.ok, false);
    assert.match(
      result.ok ? "" : result.error,
      /is 89 bytes long; it may be at most 88, since a Unix socket path on macOS holds at most 103 and the host's claim beside it adds 15/,
    );
  });

  it("names the folder that holds the socket", () => {
    assert.equal(
      socketFolder("/state/declarative-tab-groups/host.sock"),
      "/state/declarative-tab-groups",
    );
  });
});

describe("folderProblem", () => {
  const folder = {
    isDirectory: true,
    isSymbolicLink: false,
    uid: 501,
    mode: 0o40700,
  };

  it("accepts the user's own folder that only the user can enter", () => {
    assert.equal(folderProblem("/f", folder, 501), null);
    assert.equal(folderProblem("/f", { ...folder, mode: 0o40744 }, 501), null);
  });

  it("refuses a folder another user owns", () => {
    assert.match(
      folderProblem("/f", { ...folder, uid: 0 }, 501) ?? "",
      /another user/,
    );
  });

  it("refuses a folder its group or others can enter", () => {
    for (const mode of [0o40710, 0o40701, 0o40755, 0o41777]) {
      assert.match(
        folderProblem("/f", { ...folder, mode }, 501) ?? "",
        /entered by other users/,
      );
    }
  });

  it("refuses a link and a file", () => {
    assert.match(
      folderProblem(
        "/f",
        { ...folder, isSymbolicLink: true, isDirectory: false },
        501,
      ) ?? "",
      /not a folder/,
    );
    assert.match(
      folderProblem("/f", { ...folder, isDirectory: false }, 501) ?? "",
      /not a folder/,
    );
  });
});
