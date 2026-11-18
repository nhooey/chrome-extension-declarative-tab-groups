// `install` and `uninstall` as processes, run from a package laid out as
// the Nix package is, with HOME and XDG_DATA_HOME in a temporary folder.

import assert from "node:assert/strict";
import {
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { buildExtension, buildPrograms } from "../../scripts/build.ts";
import {
  hostManifestProblems,
  packageProblems,
} from "../../scripts/check-host-manifest.ts";
import { layOutPackage } from "../../scripts/package.ts";
import { EXTENSION_ORIGIN } from "../../src/host/guard.ts";
import { NATIVE_HOST_NAME } from "../../src/extension/identity.ts";
import {
  COMMAND_ENTRY,
  type Finished,
  runProgram,
  shortTemporaryFolder,
} from "../host/processes.ts";

const MANIFEST_FILE = `${NATIVE_HOST_NAME}.json`;

describe("install and uninstall as processes", () => {
  let folder = "";
  let pkg = "";
  let home = "";
  let chrome = "";
  let data = "";

  const run = (args: readonly string[]): Promise<Finished> =>
    runProgram(join(pkg, "bin/declarative-tab-groups"), args, {
      HOME: home,
      XDG_DATA_HOME: data,
    });

  /** Every entry under `relative` in the home folder, without following links, a link shown with its target. */
  const walk = async (relative: string): Promise<readonly string[]> => {
    const entries = await readdir(join(home, relative), {
      withFileTypes: true,
    });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
        return entry.isSymbolicLink()
          ? [`${path} -> ${await readlink(join(home, path))}`]
          : entry.isDirectory()
            ? [path, ...(await walk(path))]
            : [path];
      }),
    );
    return nested.flat();
  };

  const tree = async (): Promise<readonly string[]> =>
    (await walk("")).toSorted();

  before(async () => {
    folder = await realpath(await shortTemporaryFolder());
    pkg = join(folder, "pkg");
    await buildExtension(join(folder, "dist", "extension"));
    await buildPrograms(join(folder, "dist", "programs"));
    await layOutPackage(pkg, join(folder, "dist"));
  });

  after(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  beforeEach(async () => {
    home = join(folder, "home");
    data = join(home, "data");
    chrome = join(
      home,
      "Library/Application Support/Google/Chrome/NativeMessagingHosts",
    );
    await rm(home, { recursive: true, force: true });
    await mkdir(home);
  });

  it("lays out a package whose host manifest names its own host for this extension", async () => {
    assert.deepEqual(await packageProblems(pkg), []);
    const manifest = JSON.parse(
      await readFile(
        join(
          pkg,
          "share/declarative-tab-groups/native-messaging-host",
          MANIFEST_FILE,
        ),
        "utf8",
      ),
    );
    assert.equal(
      manifest.path,
      join(pkg, "libexec/declarative-tab-groups-host"),
    );
    assert.deepEqual(manifest.allowed_origins, [EXTENSION_ORIGIN]);
  });

  it(
    "install makes exactly the two links, and a second install changes nothing",
    { skip: process.platform !== "darwin" && "macOS only" },
    async () => {
      const expected = [
        "Library",
        "Library/Application Support",
        "Library/Application Support/Google",
        "Library/Application Support/Google/Chrome",
        "Library/Application Support/Google/Chrome/NativeMessagingHosts",
        `Library/Application Support/Google/Chrome/NativeMessagingHosts/${MANIFEST_FILE} -> ${pkg}/share/declarative-tab-groups/native-messaging-host/${MANIFEST_FILE}`,
        "data",
        "data/declarative-tab-groups",
        `data/declarative-tab-groups/extension -> ${pkg}/share/declarative-tab-groups/extension`,
      ];
      const first = await run(["install"]);
      assert.equal(first.status, 0, first.stderr);
      assert.deepEqual(await tree(), expected);
      assert.match(first.stdout, /Load unpacked/);

      const second = await run(["install"]);
      assert.equal(second.status, 0, second.stderr);
      assert.deepEqual(await tree(), expected);
      assert.match(second.stdout, /^keep link .*\nkeep link .*\n\n/);
    },
  );

  it(
    "install --dry-run changes nothing",
    { skip: process.platform !== "darwin" && "macOS only" },
    async () => {
      const finished = await run(["install", "--dry-run"]);
      assert.equal(finished.status, 0, finished.stderr);
      assert.match(
        finished.stdout,
        /^--dry-run: nothing is changed\nmake folder /,
      );
      assert.deepEqual(await tree(), []);
    },
  );

  it(
    "install replaces a link to an older package",
    { skip: process.platform !== "darwin" && "macOS only" },
    async () => {
      const link = join(data, "declarative-tab-groups/extension");
      await mkdir(join(data, "declarative-tab-groups"), { recursive: true });
      await symlink(
        join(folder, "old/share/declarative-tab-groups/extension"),
        link,
      );
      const finished = await run(["install"]);
      assert.equal(finished.status, 0, finished.stderr);
      assert.equal(
        await readlink(link),
        join(pkg, "share/declarative-tab-groups/extension"),
      );
    },
  );

  it(
    "uninstall removes exactly the two links, and leaves the folders and other hosts",
    { skip: process.platform !== "darwin" && "macOS only" },
    async () => {
      assert.equal((await run(["install"])).status, 0);
      await writeFile(join(chrome, "com.example.other.json"), "{}\n");
      const before = await tree();
      const finished = await run(["uninstall"]);
      assert.equal(finished.status, 0, finished.stderr);
      assert.deepEqual(
        await tree(),
        before.filter((entry) => !entry.includes(" -> ")),
      );
      assert.equal(
        finished.stdout,
        `remove link ${join(chrome, MANIFEST_FILE)} -> ${pkg}/share/declarative-tab-groups/native-messaging-host/${MANIFEST_FILE}\nremove link ${join(data, "declarative-tab-groups/extension")} -> ${pkg}/share/declarative-tab-groups/extension\n`,
      );
    },
  );

  it(
    "install refuses a foreign file, exiting 1 and changing nothing, and uninstall leaves it",
    { skip: process.platform !== "darwin" && "macOS only" },
    async () => {
      await mkdir(chrome, { recursive: true });
      await writeFile(join(chrome, MANIFEST_FILE), "{}\n");
      const before = await tree();
      const install = await run(["install"]);
      assert.equal(install.status, 1);
      assert.equal(install.stdout, "");
      assert.ok(
        install.stderr.includes(
          `  ${join(chrome, MANIFEST_FILE)} is a file, not this tool's link\n`,
        ),
        install.stderr,
      );
      assert.deepEqual(await tree(), before);

      const uninstall = await run(["uninstall"]);
      assert.equal(uninstall.status, 0);
      assert.match(
        uninstall.stdout,
        /^leave .*: it is a file, not this tool's link\n/,
      );
      assert.deepEqual(await tree(), before);
      assert.equal(await readFile(join(chrome, MANIFEST_FILE), "utf8"), "{}\n");
    },
  );

  it(
    "install refuses to run from the sources",
    { skip: process.platform !== "darwin" && "macOS only" },
    async () => {
      const finished = await runProgram(COMMAND_ENTRY, ["install"], {
        HOME: home,
      });
      assert.equal(finished.status, 1);
      assert.match(
        finished.stderr,
        /install runs only from an installed package/,
      );
      assert.deepEqual(await tree(), []);
    },
  );

  it("prints the help of install and uninstall", async () => {
    for (const command of ["install", "uninstall"]) {
      const finished = await run([command, "--help"]);
      assert.equal(finished.status, 0);
      assert.match(
        finished.stdout,
        new RegExp(`^declarative-tab-groups ${command}: `),
      );
      assert.match(
        finished.stdout,
        /\n {2}--dry-run {4}print each step and change nothing\n/,
      );
    }
  });
});

describe("hostManifestProblems", () => {
  const host = "/nix/store/p/libexec/declarative-tab-groups-host";
  const good = {
    name: NATIVE_HOST_NAME,
    description: "d",
    path: host,
    type: "stdio",
    allowed_origins: [EXTENSION_ORIGIN],
  };
  const problems = (manifest: unknown): readonly string[] =>
    hostManifestProblems(JSON.stringify(manifest), host);

  it("finds nothing wrong with a right manifest", () => {
    assert.deepEqual(problems(good), []);
  });

  it("finds each fault", () => {
    assert.deepEqual(hostManifestProblems("{", host), [
      "it is not a JSON object",
    ]);
    assert.equal(problems({ ...good, name: "other" }).length, 1);
    assert.equal(problems({ ...good, path: "/usr/bin/host" }).length, 1);
    assert.equal(problems({ ...good, type: "socket" }).length, 1);
    assert.equal(problems({ ...good, description: "" }).length, 1);
    assert.equal(
      problems({
        ...good,
        allowed_origins: [EXTENSION_ORIGIN, "chrome-extension://x/"],
      }).length,
      1,
    );
    assert.equal(problems({ ...good, allowed_extensions: [] }).length, 1);
  });
});
