import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EXTENSION_ID } from "../../src/extension/identity.ts";
import {
  EXTENSION_ORIGIN,
  isExtensionOrigin,
  isGoogleChromeExecutable,
} from "../../src/host/guard.ts";

describe("isGoogleChromeExecutable", () => {
  it("accepts stable Google Chrome's executable", () => {
    assert.equal(
      isGoogleChromeExecutable(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ),
      true,
    );
    assert.equal(
      isGoogleChromeExecutable(
        "/Volumes/Apps/Google Chrome.app/Contents/MacOS/Google Chrome",
      ),
      true,
    );
  });

  it("refuses every other browser, Chrome's other channels included", () => {
    [
      "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Arc.app/Contents/MacOS/Arc",
      "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper",
      "/usr/local/bin/node",
      "Google Chrome",
    ].forEach((path) =>
      assert.equal(isGoogleChromeExecutable(path), false, path),
    );
  });

  it("refuses an empty path and a failed lookup", () => {
    assert.equal(isGoogleChromeExecutable(""), false);
    assert.equal(isGoogleChromeExecutable(null), false);
  });
});

describe("isExtensionOrigin", () => {
  it("accepts exactly this tool's extension's origin", () => {
    assert.equal(EXTENSION_ORIGIN, `chrome-extension://${EXTENSION_ID}/`);
    assert.equal(isExtensionOrigin(EXTENSION_ORIGIN), true);
  });

  it("refuses any other origin, and none", () => {
    [
      undefined,
      "",
      `chrome-extension://${EXTENSION_ID}`,
      `chrome-extension://${EXTENSION_ID}/x`,
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
      `CHROME-EXTENSION://${EXTENSION_ID}/`,
    ].forEach((origin) =>
      assert.equal(isExtensionOrigin(origin), false, String(origin)),
    );
  });
});
