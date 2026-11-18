import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseArguments, usageText } from "../../src/command/arguments.ts";
import {
  GET_HELP,
  INSTALL_HELP,
  MAIN_HELP,
  SET_HELP,
  STATUS_HELP,
  UNINSTALL_HELP,
} from "../../src/command/help.ts";

const usageError = (args: readonly string[]): string => {
  const invocation = parseArguments(args);
  assert.equal(invocation.kind, "usage-error", JSON.stringify(args));
  return invocation.kind === "usage-error" ? invocation.message : "";
};

describe("parseArguments: set", () => {
  it("takes the group and the URLs, leaving the optional fields out", () => {
    assert.deepEqual(
      parseArguments([
        "set",
        "--group",
        "Reading",
        "https://a.example/",
        "https://b.example/",
      ]),
      {
        kind: "run",
        command: {
          command: "set",
          group: "Reading",
          createWindow: false,
          urls: {
            kind: "arguments",
            urls: ["https://a.example/", "https://b.example/"],
          },
          json: false,
        },
      },
    );
  });

  it("takes every option, in either spelling of a value", () => {
    assert.deepEqual(
      parseArguments([
        "set",
        "--group=Read later",
        "--color",
        "blue",
        "--create-window",
        "--no-status-page",
        "--urls-from",
        "-",
        "--json",
      ]),
      {
        kind: "run",
        command: {
          command: "set",
          group: "Read later",
          color: "blue",
          createWindow: true,
          statusPage: false,
          urls: { kind: "file", path: "-" },
          json: true,
        },
      },
    );
    const on = parseArguments(["set", "--group", "g", "--status-page"]);
    assert.equal(
      on.kind === "run" &&
        on.command.command === "set" &&
        on.command.statusPage,
      true,
    );
  });

  it("allows no URL at all, which empties the group", () => {
    const invocation = parseArguments(["set", "--group", "g"]);
    assert.deepEqual(
      invocation.kind === "run" && invocation.command.command === "set"
        ? invocation.command.urls
        : null,
      { kind: "arguments", urls: [] },
    );
  });

  it("takes arguments after -- as URLs", () => {
    const invocation = parseArguments(["set", "--group", "g", "--", "--json"]);
    assert.deepEqual(
      invocation.kind === "run" && invocation.command.command === "set"
        ? invocation.command
        : null,
      {
        command: "set",
        group: "g",
        createWindow: false,
        urls: { kind: "arguments", urls: ["--json"] },
        json: false,
      },
    );
  });

  it("reports each usage error", () => {
    assert.equal(usageError(["set"]), "set needs --group <title>");
    assert.equal(usageError(["set", "--group"]), "--group needs a value");
    assert.equal(
      usageError(["set", "--group", "g", "--color", "mauve"]),
      '--color must be one of grey, blue, red, yellow, green, pink, purple, cyan, orange, not "mauve"',
    );
    assert.equal(
      usageError(["set", "--group", "g", "--status-page", "--no-status-page"]),
      "--status-page and --no-status-page cannot both be given",
    );
    assert.equal(
      usageError([
        "set",
        "--group",
        "g",
        "--urls-from",
        "f",
        "https://a.example/",
      ]),
      "give URLs as arguments or with --urls-from, not both",
    );
    assert.equal(
      usageError(["set", "--group", "a", "--group", "b"]),
      "--group is given more than once",
    );
    assert.equal(
      usageError(["set", "--group", "g", "--json=yes"]),
      "--json takes no value",
    );
    assert.equal(
      usageError(["set", "--group", "g", "--focus"]),
      "unknown option --focus",
    );
  });
});

describe("parseArguments: get and status", () => {
  it("parses get and status", () => {
    assert.deepEqual(parseArguments(["get", "--group", "Reading"]), {
      kind: "run",
      command: { command: "get", group: "Reading", json: false },
    });
    assert.deepEqual(parseArguments(["status", "--json"]), {
      kind: "run",
      command: { command: "status", json: true },
    });
  });

  it("reports each usage error", () => {
    assert.equal(usageError(["get"]), "get needs --group <title>");
    assert.equal(
      usageError(["get", "--group", "g", "extra"]),
      'get takes no arguments, but was given "extra"',
    );
    assert.equal(
      usageError(["status", "--group", "g"]),
      "unknown option --group",
    );
    assert.equal(
      usageError(["status", "now"]),
      'status takes no arguments, but was given "now"',
    );
  });
});

describe("parseArguments: install and uninstall", () => {
  it("parses each, with and without --dry-run", () => {
    assert.deepEqual(parseArguments(["install"]), {
      kind: "run",
      command: { command: "install", dryRun: false },
    });
    assert.deepEqual(parseArguments(["uninstall", "--dry-run"]), {
      kind: "run",
      command: { command: "uninstall", dryRun: true },
    });
  });

  it("prints each one's help", () => {
    assert.deepEqual(parseArguments(["install", "--help"]), {
      kind: "help",
      text: INSTALL_HELP,
    });
    assert.deepEqual(parseArguments(["uninstall", "-h"]), {
      kind: "help",
      text: UNINSTALL_HELP,
    });
  });

  it("reports each usage error", () => {
    assert.equal(
      usageError(["install", "/Applications"]),
      'install takes no arguments, but was given "/Applications"',
    );
    assert.equal(usageError(["uninstall", "--json"]), "unknown option --json");
    assert.equal(
      usageError(["install", "--dry-run=yes"]),
      "--dry-run takes no value",
    );
  });
});

describe("parseArguments: the command", () => {
  it("prints help for the command and each subcommand, before any other check", () => {
    assert.deepEqual(parseArguments(["--help"]), {
      kind: "help",
      text: MAIN_HELP,
    });
    assert.deepEqual(parseArguments(["-h"]), { kind: "help", text: MAIN_HELP });
    assert.deepEqual(parseArguments(["set", "--bogus", "--help"]), {
      kind: "help",
      text: SET_HELP,
    });
    assert.deepEqual(parseArguments(["get", "-h"]), {
      kind: "help",
      text: GET_HELP,
    });
    assert.deepEqual(parseArguments(["status", "--help"]), {
      kind: "help",
      text: STATUS_HELP,
    });
  });

  it("prints the version", () => {
    assert.deepEqual(parseArguments(["--version"]), { kind: "version" });
  });

  it("reports a missing or unknown command", () => {
    assert.equal(
      usageError([]),
      "a command is needed: set, get, status, install or uninstall",
    );
    assert.equal(
      usageError(["open"]),
      'unknown command "open"; the commands are set, get, status, install and uninstall',
    );
    assert.equal(usageError(["--verbose"]), "unknown option --verbose");
    assert.equal(
      usageError(["--version", "x"]),
      "--version takes no arguments",
    );
  });

  it("points a usage error at the right help", () => {
    assert.equal(
      usageText("set needs --group <title>", "set"),
      'declarative-tab-groups: set needs --group <title>\nRun "declarative-tab-groups set --help" for usage.\n',
    );
    assert.equal(
      usageText("a command is needed: set, get or status", null),
      'declarative-tab-groups: a command is needed: set, get or status\nRun "declarative-tab-groups --help" for usage.\n',
    );
  });

  it("gives every help its purpose, options, exit statuses and an example", () => {
    const statuses = (help: string): readonly string[] =>
      [...(help.split("\nExit statuses:\n")[1] ?? "").matchAll(/^ {2}(\d) /gm)]
        .map((match) => match[1] ?? "")
        .filter((status) => status !== "");
    [
      { help: MAIN_HELP, exits: ["0", "1", "2", "3", "4"] },
      { help: SET_HELP, exits: ["0", "1", "2", "3", "4"] },
      { help: GET_HELP, exits: ["0", "1", "2", "3", "4"] },
      { help: STATUS_HELP, exits: ["0", "1", "2", "3", "4"] },
      { help: INSTALL_HELP, exits: ["0", "1", "2"] },
      { help: UNINSTALL_HELP, exits: ["0", "1", "2"] },
    ].forEach(({ help, exits }) => {
      assert.match(help, /^declarative-tab-groups[ a-z]*: /);
      assert.match(help, /\nOptions:\n/);
      assert.deepEqual(statuses(help), exits);
      assert.match(help, /\nExample:\n {2}/);
    });
  });
});
