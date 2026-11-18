// The unpacked extension `npm run build` writes: every file the manifest
// and the empty page name is there, and the empty page names its group.

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { runInNewContext } from "node:vm";

import { buildExtension } from "../../scripts/build.ts";

describe("the unpacked extension", () => {
  let parent = "";
  let out = "";

  before(async () => {
    parent = await mkdtemp(join(tmpdir(), "declarative-tab-groups-build-"));
    out = join(parent, "extension");
    await buildExtension(out);
  });

  after(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it("holds the manifest, the service worker and the empty page", async () => {
    assert.deepEqual((await readdir(out)).toSorted(), [
      "empty.html",
      "empty.js",
      "manifest.json",
      "service-worker.js",
    ]);
    const manifest = JSON.parse(
      await readFile(join(out, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.background.service_worker, "service-worker.js");
    assert.match(
      await readFile(join(out, "empty.html"), "utf8"),
      /<script src="empty\.js" defer><\/script>/,
    );
  });

  it("bundles the service worker into one file", async () => {
    const worker = await readFile(join(out, "service-worker.js"), "utf8");
    assert.doesNotMatch(worker, /^\s*import\s/m);
    assert.match(worker, /io\.github\.nhooey\.declarative_tab_groups/);
  });

  it("names the group on the empty page", async () => {
    const script = await readFile(join(out, "empty.js"), "utf8");
    const heading = { textContent: "this tab is in" };
    const document = {
      title: "Empty tab group",
      getElementById: (id: string) => (id === "group" ? heading : null),
    };
    runInNewContext(script, {
      URLSearchParams,
      location: { search: "?group=Read%20later" },
      document,
    });
    assert.equal(document.title, "Read later (empty)");
    assert.equal(heading.textContent, "Read later");
  });
});
