// The install code and the Home Manager module name no browser folder but
// Google Chrome's: they never write where another browser reads.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/** The files that decide where `install` and the module put links. */
const FILES = [
  "src/command/install.ts",
  "src/command/install-plan.ts",
  "src/command/layout.ts",
  "src/command/layout.json",
  "nix/home-manager-module.nix",
] as const;

const OTHER_BROWSERS =
  /\b(?:BraveSoftware|Brave|Chromium|Microsoft Edge|Chrome Beta|Chrome Canary|Chrome Dev|Arc|Vivaldi|Opera)\b/;

const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("the install code and the Home Manager module", () => {
  it("name no other browser", () => {
    FILES.forEach((path) => {
      const match = read(path).match(OTHER_BROWSERS);
      assert.equal(match, null, `${path} names ${match?.[0]}`);
    });
  });

  it("name one Application Support folder, Google Chrome's native-messaging folder", () => {
    const folders = FILES.flatMap((path) =>
      [...read(path).matchAll(/Application Support(?:\/[\w.-]+)+/g)].map(
        (match) => match[0],
      ),
    );
    assert.deepEqual(
      [...new Set(folders)],
      ["Application Support/Google/Chrome/NativeMessagingHosts"],
    );
  });
});
