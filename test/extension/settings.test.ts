// The status-page setting and a request's `statusPage` field over it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_SETTINGS,
  readSettings,
  type SettingsStorage,
  statusPageWanted,
} from "../../src/extension/settings.ts";

const storing = (stored: {
  readonly [key: string]: unknown;
}): SettingsStorage => ({
  get: (defaults) => Promise.resolve({ ...defaults, ...stored }),
  set: () => Promise.resolve(),
});

describe("statusPageWanted", () => {
  it("takes the request's field over the setting", () => {
    assert.equal(statusPageWanted({ statusPage: true }, false), true);
    assert.equal(statusPageWanted({ statusPage: false }, true), false);
  });

  it("takes the setting when the request says nothing", () => {
    assert.equal(statusPageWanted({}, true), true);
    assert.equal(statusPageWanted({}, false), false);
  });

  it("is on by default", () => {
    assert.equal(statusPageWanted({}, DEFAULT_SETTINGS.statusPage), true);
  });
});

describe("readSettings", () => {
  it("reads the stored setting", async () => {
    assert.deepEqual(await readSettings(storing({ statusPage: false })), {
      statusPage: false,
    });
  });

  it("is the default when nothing is stored, the value is malformed, or storage fails", async () => {
    assert.deepEqual(await readSettings(storing({})), DEFAULT_SETTINGS);
    assert.deepEqual(
      await readSettings(storing({ statusPage: "no" })),
      DEFAULT_SETTINGS,
    );
    assert.deepEqual(
      await readSettings({
        get: () => Promise.reject(new Error("no storage")),
        set: () => Promise.resolve(),
      }),
      DEFAULT_SETTINGS,
    );
  });
});
