// `install` and `uninstall` through their edge, on an in-memory file
// system that records every change.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type Files, runSetup } from "../../src/command/install.ts";
import type { Entry } from "../../src/command/install-plan.ts";

const HOME = "/home/u";
const HOST_FOLDER = `${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts`;
const HOST_LINK = `${HOST_FOLDER}/io.github.nhooey.declarative_tab_groups.json`;
const DATA_FOLDER = `${HOME}/.local/share/declarative-tab-groups`;
const EXTENSION_LINK = `${DATA_FOLDER}/extension`;
const PACKAGE = "/nix/store/p-declarative-tab-groups";
const ENTRY = `${PACKAGE}/lib/declarative-tab-groups/declarative-tab-groups.mjs`;
const HOST_MANIFEST = `${PACKAGE}/share/declarative-tab-groups/native-messaging-host/io.github.nhooey.declarative_tab_groups.json`;
const EXTENSION = `${PACKAGE}/share/declarative-tab-groups/extension`;

/** A file system of the given entries, with `/bin/dtg` linking to the command. */
const memoryFiles = (initial: readonly (readonly [string, Entry])[]) => {
  const entries = new Map<string, Entry>([
    [ENTRY, { kind: "other" }],
    [HOST_MANIFEST, { kind: "other" }],
    [EXTENSION, { kind: "folder" }],
    ...initial,
  ]);
  const changes: string[] = [];
  const lookAt = async (path: string): Promise<Entry> =>
    entries.get(path) ?? { kind: "missing" };
  const lookThrough = async (path: string): Promise<Entry> => {
    const entry = await lookAt(path);
    return entry.kind === "link" ? lookThrough(entry.target) : entry;
  };
  const files: Files = {
    realPath: async (path) => {
      const entry = await lookAt(path);
      return entry.kind === "link" ? entry.target : path;
    },
    lookAt,
    lookThrough,
    makeFolder: async (path) => {
      changes.push(`make-folder ${path}`);
      entries.set(path, { kind: "folder" });
    },
    link: async (path, target) => {
      if (entries.has(path)) {
        throw new Error(`EEXIST: ${path}`);
      }
      changes.push(`link ${path} ${target}`);
      entries.set(path, { kind: "link", target });
    },
    removeLink: async (path) => {
      changes.push(`remove-link ${path}`);
      entries.delete(path);
    },
  };
  return { files, changes, entries };
};

const setup = (
  command: "install" | "uninstall",
  dryRun: boolean,
  files: Files,
  options: { readonly platform?: string; readonly entry?: string } = {},
) =>
  runSetup(
    { command, dryRun },
    {
      env: { HOME },
      platform: options.platform ?? "darwin",
      entry: options.entry ?? "/bin/dtg",
      files,
    },
  );

const commandLink: readonly [string, Entry] = [
  "/bin/dtg",
  { kind: "link", target: ENTRY },
];

describe("install", () => {
  it("makes the missing folder and both links, then says how to load the extension", async () => {
    const { files, changes } = memoryFiles([
      commandLink,
      [HOST_FOLDER, { kind: "folder" }],
    ]);
    const result = await setup("install", false, files);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(changes, [
      `link ${HOST_LINK} ${HOST_MANIFEST}`,
      `make-folder ${DATA_FOLDER}`,
      `link ${EXTENSION_LINK} ${EXTENSION}`,
    ]);
    assert.match(result.stdout, /chrome:\/\/extensions/);
    assert.match(result.stdout, /Load unpacked/);
    assert.match(result.stdout, /Allow access to file URLs/);
    assert.ok(result.stdout.includes(`\n     ${EXTENSION_LINK}\n`));
  });

  it("with --dry-run prints each step and changes nothing", async () => {
    const { files, changes } = memoryFiles([commandLink]);
    const result = await setup("install", true, files);
    assert.equal(result.status, 0);
    assert.deepEqual(changes, []);
    assert.ok(
      result.stdout.startsWith(
        [
          "--dry-run: nothing is changed",
          `make folder ${HOST_FOLDER}`,
          `link ${HOST_LINK} -> ${HOST_MANIFEST}`,
          `make folder ${DATA_FOLDER}`,
          `link ${EXTENSION_LINK} -> ${EXTENSION}`,
          "",
        ].join("\n"),
      ),
      result.stdout,
    );
  });

  it("refuses, changing nothing, when a path holds something else", async () => {
    const { files, changes } = memoryFiles([
      commandLink,
      [HOST_FOLDER, { kind: "folder" }],
      [DATA_FOLDER, { kind: "folder" }],
      [EXTENSION_LINK, { kind: "folder" }],
    ]);
    for (const dryRun of [false, true]) {
      const result = await setup("install", dryRun, files);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(
        result.stderr,
        `declarative-tab-groups: install changes nothing, since a path it needs holds something else:\n  ${EXTENSION_LINK} is a folder, not this tool's link\nMove each away, then run install again.\n`,
      );
    }
    assert.deepEqual(changes, []);
  });

  it("replaces an older package's link and keeps a right one", async () => {
    const old =
      "/nix/store/o-declarative-tab-groups/share/declarative-tab-groups/extension";
    const { files, changes } = memoryFiles([
      commandLink,
      [HOST_FOLDER, { kind: "folder" }],
      [HOST_LINK, { kind: "link", target: HOST_MANIFEST }],
      [DATA_FOLDER, { kind: "folder" }],
      [EXTENSION_LINK, { kind: "link", target: old }],
    ]);
    const result = await setup("install", false, files);
    assert.equal(result.status, 0);
    assert.deepEqual(changes, [
      `remove-link ${EXTENSION_LINK}`,
      `link ${EXTENSION_LINK} ${EXTENSION}`,
    ]);
    assert.match(
      result.stdout,
      new RegExp(
        `^keep link ${HOST_LINK} -> ${HOST_MANIFEST}\nreplace link ${EXTENSION_LINK} -> ${old} with -> ${EXTENSION}\n`,
      ),
    );
  });

  it("reports a step that fails, after the steps done", async () => {
    const { files } = memoryFiles([commandLink]);
    const result = await setup("install", false, {
      ...files,
      link: async () => {
        throw new Error("EACCES: permission denied");
      },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, `make folder ${HOST_FOLDER}\n`);
    assert.equal(
      result.stderr,
      `declarative-tab-groups: link ${HOST_LINK} -> ${HOST_MANIFEST} failed: EACCES: permission denied\n`,
    );
  });

  it("runs only from an installed package", async () => {
    const { files, changes } = memoryFiles([]);
    const result = await setup("install", false, files, {
      entry: "/src/command/main.ts",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /install runs only from an installed package/);
    assert.deepEqual(changes, []);
  });
});

describe("uninstall", () => {
  it("removes this tool's links and leaves anything else, saying so", async () => {
    const { files, changes } = memoryFiles([
      [HOST_FOLDER, { kind: "folder" }],
      [HOST_LINK, { kind: "other" }],
      [DATA_FOLDER, { kind: "folder" }],
      [EXTENSION_LINK, { kind: "link", target: EXTENSION }],
    ]);
    const result = await setup("uninstall", false, files);
    assert.deepEqual(result, {
      stdout: `leave ${HOST_LINK}: it is a file, not this tool's link\nremove link ${EXTENSION_LINK} -> ${EXTENSION}\n`,
      stderr: "",
      status: 0,
    });
    assert.deepEqual(changes, [`remove-link ${EXTENSION_LINK}`]);
  });

  it("with --dry-run prints each step and changes nothing", async () => {
    const { files, changes } = memoryFiles([
      [EXTENSION_LINK, { kind: "link", target: EXTENSION }],
    ]);
    const result = await setup("uninstall", true, files);
    assert.equal(
      result.stdout,
      `--dry-run: nothing is changed\nnothing at ${HOST_LINK}\nremove link ${EXTENSION_LINK} -> ${EXTENSION}\n`,
    );
    assert.deepEqual(changes, []);
  });
});

describe("install and uninstall elsewhere than macOS", () => {
  it("say so and exit 1, changing nothing", async () => {
    for (const command of ["install", "uninstall"] as const) {
      const { files, changes } = memoryFiles([commandLink]);
      const result = await setup(command, false, files, { platform: "linux" });
      assert.deepEqual(result, {
        stdout: "",
        stderr: `declarative-tab-groups: ${command} works only on macOS, and this is linux\n`,
        status: 1,
      });
      assert.deepEqual(changes, []);
    }
  });
});

describe("install with a HOME that is not absolute", () => {
  it("is a usage error", async () => {
    const { files } = memoryFiles([commandLink]);
    const result = await runSetup(
      { command: "install", dryRun: false },
      { env: { HOME: "u" }, platform: "darwin", entry: "/bin/dtg", files },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /HOME must be an absolute path/);
  });
});
