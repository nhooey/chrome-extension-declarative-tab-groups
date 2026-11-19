import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chromeVersion, isGoogleChrome } from "../../src/extension/browser.ts";
import { BRANDS } from "./brands.ts";

describe("isGoogleChrome", () => {
  it("is true for Google Chrome's brands", () => {
    assert.equal(isGoogleChrome(BRANDS.chrome), true);
  });

  it("is false for Brave's, Edge's and Chromium's brands", () => {
    assert.equal(isGoogleChrome(BRANDS.brave), false);
    assert.equal(isGoogleChrome(BRANDS.edge), false);
    assert.equal(isGoogleChrome(BRANDS.chromium), false);
    assert.equal(isGoogleChrome([]), false);
  });
});

describe("chromeVersion", () => {
  it("prefers the full version list", () => {
    assert.equal(
      chromeVersion(
        [
          { brand: "Chromium", version: "142.0.7444.176" },
          { brand: "Google Chrome", version: "142.0.7444.176" },
        ],
        BRANDS.chrome,
      ),
      "142.0.7444.176",
    );
  });

  it("falls back to the brands' major version, then to unknown", () => {
    assert.equal(chromeVersion(undefined, BRANDS.chrome), "142");
    assert.equal(chromeVersion([], BRANDS.brave), "unknown");
  });
});
