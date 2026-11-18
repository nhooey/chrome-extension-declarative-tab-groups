// The extension's service worker, as manifest.json names it once bundled:
// it hands Chrome to `startServiceWorker`, the tab strip through
// `narrowTabStrip` only. Every listener is added in the worker's first
// turn, as Chrome requires to wake it for an event.

import { type Brand, chromeVersion } from "./browser.ts";
import { startServiceWorker } from "./service-worker.ts";
import { narrowTabStrip } from "./tab-strip.ts";

/** `navigator.userAgentData`, which Chromium browsers give a service worker. */
type UserAgentData = {
  readonly brands: readonly Brand[];
  readonly getHighEntropyValues: (
    hints: string[],
  ) => Promise<{ readonly fullVersionList?: readonly Brand[] }>;
};

const userAgentData = (navigator as { readonly userAgentData?: UserAgentData })
  .userAgentData;

startServiceWorker({
  brands: userAgentData?.brands,
  connectNative: (application) => chrome.runtime.connectNative(application),
  lastError: () => chrome.runtime.lastError?.message ?? null,
  onStartup: chrome.runtime.onStartup,
  onInstalled: {
    addListener: (listener) =>
      chrome.runtime.onInstalled.addListener(() => listener()),
  },
  alarms: {
    create: (name, info) => chrome.alarms.create(name, info),
    clear: (name) => chrome.alarms.clear(name),
    onAlarm: chrome.alarms.onAlarm,
  },
  log: (message) => console.info(`declarative-tab-groups: ${message}`),
  services: {
    tabStrip: narrowTabStrip(chrome),
    clock: {
      now: () => Date.now(),
      sleep: (milliseconds, signal) =>
        new Promise((resolve) => {
          const timer = setTimeout(resolve, milliseconds);
          signal?.addEventListener("abort", () => clearTimeout(timer), {
            once: true,
          });
        }),
    },
    pages: { empty: chrome.runtime.getURL("empty.html") },
    versions: async () => ({
      extension: chrome.runtime.getManifest().version,
      chrome: chromeVersion(
        (await userAgentData?.getHighEntropyValues(["fullVersionList"]))
          ?.fullVersionList,
        userAgentData?.brands ?? [],
      ),
    }),
  },
});
