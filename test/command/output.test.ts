import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RequestCommand } from "../../src/command/arguments.ts";
import {
  EXIT,
  exitStatus,
  output,
  requestFor,
  urlsFromText,
} from "../../src/command/output.ts";
import {
  encode,
  failure,
  type GetSuccess,
  type SetSuccess,
  type StatusSuccess,
} from "../../src/protocol/index.ts";

const setCommand: RequestCommand = {
  command: "set",
  group: "Reading",
  createWindow: false,
  urls: { kind: "arguments", urls: [] },
  json: false,
};

const setSuccess: SetSuccess = {
  protocol: 1,
  ok: true,
  command: "set",
  group: { title: "Reading", windowId: 1754, created: false },
  opened: 3,
  closed: 4,
  kept: [],
  unchecked: 0,
  loading: 0,
};

const getSuccess: GetSuccess = {
  protocol: 1,
  ok: true,
  command: "get",
  group: { title: "Reading", windowId: 1754 },
  tabs: [
    { url: "https://example.com/", title: "Example" },
    { url: "file:///tmp/notes.html", title: "Notes" },
  ],
};

const statusSuccess: StatusSuccess = {
  protocol: 1,
  ok: true,
  command: "status",
  extension: "0.1.0",
  chrome: "142.0.7444.176",
};

const line = (response: object) => ({
  kind: "line" as const,
  line: encode(response as SetSuccess).trimEnd(),
});

describe("requestFor", () => {
  it("builds set with only the fields given", () => {
    assert.deepEqual(requestFor(setCommand, ["https://a.example/"]), {
      protocol: 1,
      command: "set",
      group: "Reading",
      urls: ["https://a.example/"],
    });
    assert.deepEqual(
      requestFor(
        { ...setCommand, color: "red", createWindow: true, statusPage: false },
        [],
      ),
      {
        protocol: 1,
        command: "set",
        group: "Reading",
        urls: [],
        color: "red",
        createWindow: true,
        statusPage: false,
      },
    );
    assert.deepEqual(requestFor({ ...setCommand, statusPage: true }, []), {
      protocol: 1,
      command: "set",
      group: "Reading",
      urls: [],
      statusPage: true,
    });
  });

  it("builds get and status", () => {
    assert.deepEqual(
      requestFor({ command: "get", group: "Reading", json: false }, []),
      { protocol: 1, command: "get", group: "Reading" },
    );
    assert.deepEqual(requestFor({ command: "status", json: true }, []), {
      protocol: 1,
      command: "status",
    });
  });
});

describe("urlsFromText", () => {
  it("takes one URL per line, ignoring blank lines and surrounding whitespace", () => {
    assert.deepEqual(
      urlsFromText("https://a.example/\n\n  https://b.example/ \r\n\n"),
      ["https://a.example/", "https://b.example/"],
    );
    assert.deepEqual(urlsFromText(""), []);
  });
});

describe("exitStatus", () => {
  it("is 0 for a success and for set with nothing kept", () => {
    assert.equal(exitStatus(setSuccess), EXIT.success);
    assert.equal(exitStatus(getSuccess), 0);
    assert.equal(exitStatus(statusSuccess), 0);
  });

  it("is 3 for set with a tab kept", () => {
    assert.equal(
      exitStatus({
        ...setSuccess,
        kept: [{ url: "https://a.example/", title: "A" }],
      }),
      3,
    );
  });

  it("is 4 for not-connected and 1 for every other failure", () => {
    assert.equal(exitStatus(failure("not-connected", "x")), 4);
    [
      "invalid-request",
      "unsupported-protocol",
      "ambiguous-group",
      "no-group",
      "no-window",
      "busy",
      "not-google-chrome",
      "internal",
    ].forEach((code) =>
      assert.equal(exitStatus(failure(code as "busy", "x")), 1, code),
    );
  });
});

describe("output", () => {
  it("renders set: the group, the counts, each kept tab, and the counts that are not zero", () => {
    assert.deepEqual(output(setCommand, line(setSuccess), "0.1.0"), {
      stdout: '"Reading" in window 1754: opened 3, closed 4\n',
      stderr: "",
      status: 0,
    });
    assert.deepEqual(
      output(
        setCommand,
        line({
          ...setSuccess,
          group: { ...setSuccess.group, created: true },
          kept: [{ url: "https://example.org/compose", title: "New message" }],
          unchecked: 1,
          loading: 2,
        }),
        "0.1.0",
      ),
      {
        stdout: [
          '"Reading" in window 1754, created: opened 3, closed 4',
          "kept 1 tab with an unsubmitted form:",
          "  New message  https://example.org/compose",
          "1 tab was closed without the unsubmitted-form check",
          "2 tabs are still loading",
          "",
        ].join("\n"),
        stderr: "",
        status: 3,
      },
    );
  });

  it("renders get as one URL per line, and status as the versions", () => {
    const get: RequestCommand = {
      command: "get",
      group: "Reading",
      json: false,
    };
    assert.equal(
      output(get, line(getSuccess), "0.1.0").stdout,
      "https://example.com/\nfile:///tmp/notes.html\n",
    );
    assert.equal(
      output({ command: "status", json: false }, line(statusSuccess), "0.2.0")
        .stdout,
      "declarative-tab-groups 0.2.0\nextension 0.1.0\nGoogle Chrome 142.0.7444.176\n",
    );
  });

  it("prints a failure's code and message on standard error", () => {
    assert.deepEqual(
      output(
        setCommand,
        line(failure("no-window", "no window can hold it")),
        "0.1.0",
      ),
      {
        stdout: "",
        stderr: "declarative-tab-groups: no-window: no window can hold it\n",
        status: 1,
      },
    );
  });

  it("prints the response line exactly as received with --json", () => {
    const received =
      '{ "protocol": 1, "ok": true, "command": "status", "extension": "0.1.0", "chrome": "1" }';
    assert.deepEqual(
      output(
        { command: "status", json: true },
        { kind: "line", line: received },
        "0.1.0",
      ),
      { stdout: `${received}\n`, stderr: "", status: 0 },
    );
  });

  it("stands in with not-connected when nothing answered", () => {
    const outcome = { kind: "not-connected" as const, message: "no host" };
    assert.deepEqual(
      output({ command: "status", json: false }, outcome, "0.1.0"),
      {
        stdout: "",
        stderr: "declarative-tab-groups: not-connected: no host\n",
        status: 4,
      },
    );
    assert.equal(
      output({ command: "status", json: true }, outcome, "0.1.0").stdout,
      encode(failure("not-connected", "no host")),
    );
  });

  it("treats a malformed response as an internal failure", () => {
    const result = output(
      setCommand,
      { kind: "line", line: "garbage" },
      "0.1.0",
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /internal: malformed response/);
  });

  it("prints no control character in the readable account, and the exact line with --json", () => {
    const hostile = {
      ...setSuccess,
      group: { ...setSuccess.group, title: "Read\u009b2J" },
      kept: [
        {
          url: "https://example.org/\u001b]8;;x",
          title: "\u001b[2JNew\rmessage\u0007",
        },
      ],
    };
    const text = output(setCommand, line(hostile), "0.1.0").stdout;
    assert.doesNotMatch(
      text.replaceAll("\n", ""),
      /[\u0000-\u001f\u007f-\u009f]/,
    );
    assert.match(
      text,
      /\n {2}�\[2JNew�message� {2}https:\/\/example\.org\/�\]8;;x\n/,
    );
    const failed = output(
      setCommand,
      line(failure("internal", "bad\u001b[31m")),
      "0.1.0",
    );
    assert.equal(failed.stderr, "declarative-tab-groups: internal: bad�[31m\n");
    const received = line(hostile);
    assert.equal(
      output({ ...setCommand, json: true }, received, "0.1.0").stdout,
      `${received.line}\n`,
    );
  });
});
