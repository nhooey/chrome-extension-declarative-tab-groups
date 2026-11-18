// The real entry point refuses outside Google Chrome: the test runner that
// starts it is Node, so its parent check fails. This is the proof that the
// guard runs; nothing switches it off.

import assert from "node:assert/strict";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { HOST_ENTRY, shortTemporaryFolder, startHost } from "./processes.ts";

describe("the host's real entry point", () => {
  it("refuses as not-google-chrome when its parent is not Google Chrome", async () => {
    const folder = await shortTemporaryFolder();
    try {
      const socket = join(folder, "d", "h.sock");
      const host = startHost(socket, { entry: HOST_ENTRY });
      assert.deepEqual(await host.nextMessage(), {
        hello: { refused: "not-google-chrome" },
      });
      assert.equal(await host.nextMessage(), null);
      assert.notEqual(await host.exited, 0);
      assert.match(host.stderr(), /is not Google Chrome/);
      await assert.rejects(stat(join(folder, "d")), "it made no socket folder");
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
