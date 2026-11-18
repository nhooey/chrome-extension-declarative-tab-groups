// manifest.json, and the extension ID its `key` fixes.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  EXTENSION_ID,
  extensionIdFromDigest,
  extensionIdFromKey,
} from "../../src/extension/identity.ts";

const readJson = (path: string): { readonly [key: string]: unknown } =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

const manifest = readJson("../../src/extension/manifest.json");
const packageJson = readJson("../../package.json");

describe("manifest.json", () => {
  it("is a Manifest V3 extension at the package's version", () => {
    assert.equal(manifest["manifest_version"], 3);
    assert.equal(manifest["version"], packageJson["version"]);
    assert.equal(manifest["minimum_chrome_version"], "126");
  });

  it("asks for exactly the permissions the extension uses", () => {
    assert.deepEqual(manifest["permissions"], [
      "tabs",
      "tabGroups",
      "scripting",
      "nativeMessaging",
      "alarms",
    ]);
    assert.deepEqual(manifest["host_permissions"], ["<all_urls>"]);
  });

  it("never runs in an incognito window", () => {
    assert.equal(manifest["incognito"], "not_allowed");
  });

  it("runs a module service worker, and no content script or popup", () => {
    assert.deepEqual(manifest["background"], {
      service_worker: "service-worker.js",
      type: "module",
    });
    assert.deepEqual(Object.keys(manifest).toSorted(), [
      "background",
      "description",
      "host_permissions",
      "incognito",
      "key",
      "manifest_version",
      "minimum_chrome_version",
      "name",
      "permissions",
      "version",
    ]);
  });
});

describe("the extension ID", () => {
  it("is the one manifest.json's key fixes", async () => {
    assert.equal(
      await extensionIdFromKey(String(manifest["key"])),
      EXTENSION_ID,
    );
  });

  it("is the digest's first 16 bytes, each hex digit written a to p", () => {
    assert.equal(
      extensionIdFromDigest(
        Uint8Array.from([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]),
      ),
      "abcdefghijklmnop",
    );
    const key = String(manifest["key"]);
    const digest = createHash("sha256")
      .update(Buffer.from(key, "base64"))
      .digest();
    assert.equal(extensionIdFromDigest(digest), EXTENSION_ID);
    assert.match(EXTENSION_ID, /^[a-p]{32}$/);
  });
});
