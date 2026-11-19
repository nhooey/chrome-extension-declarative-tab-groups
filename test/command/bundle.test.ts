// The command and the host as `npm run build` bundles them: each is one
// file that Node runs without stripping types, and each runs.

import assert from "node:assert/strict";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { buildPrograms } from "../../scripts/build.ts";
import { VERSION } from "../../src/command/version.ts";
import {
  runProgram,
  shortTemporaryFolder,
  startHost,
} from "../host/processes.ts";

describe("the bundled programs", () => {
  let folder = "";
  let out = "";

  before(async () => {
    folder = await shortTemporaryFolder();
    out = join(folder, "programs");
    await buildPrograms(out);
  });

  after(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it("are one file each, starting with a #! line for Node, importing nothing but Node's own modules", async () => {
    assert.deepEqual((await readdir(out)).toSorted(), [
      "declarative-tab-groups-host.mjs",
      "declarative-tab-groups.mjs",
    ]);
    for (const name of await readdir(out)) {
      const text = await readFile(join(out, name), "utf8");
      assert.match(text, /^#!\/usr\/bin\/env node\n/);
      const imports = [...text.matchAll(/^import .* from "([^"]+)";$/gm)].map(
        (match) => match[1],
      );
      assert.deepEqual(
        imports.filter((source) => !source?.startsWith("node:")),
        [],
        name,
      );
    }
  });

  it("runs the command's --help and --version", async () => {
    const command = join(out, "declarative-tab-groups.mjs");
    const help = await runProgram(command, ["--help"], {});
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^declarative-tab-groups: /);
    assert.deepEqual(await runProgram(command, ["--version"], {}), {
      status: 0,
      stdout: `declarative-tab-groups ${VERSION}\n`,
      stderr: "",
    });
  });

  it("runs the host, which refuses outside Google Chrome", async () => {
    const host = startHost(join(folder, "d", "h.sock"), {
      entry: join(out, "declarative-tab-groups-host.mjs"),
    });
    assert.deepEqual(await host.nextMessage(), {
      hello: { refused: "not-google-chrome" },
    });
    assert.notEqual(await host.exited, 0);
  });
});
