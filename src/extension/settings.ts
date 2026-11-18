// The extension's one setting, whether a group holds the status page, kept
// in `chrome.storage.local` and changed on the options page, and how a
// request's `statusPage` field overrides it.

import type { SetRequest } from "../protocol/index.ts";

export type Settings = { readonly statusPage: boolean };

/** The settings until the user changes them: the status page is on. */
export const DEFAULT_SETTINGS: Settings = { statusPage: true };

/** The members of `chrome.storage.local` the settings use. */
export type SettingsStorage = {
  readonly get: (
    defaults: Settings,
  ) => Promise<{ readonly [key: string]: unknown }>;
  readonly set: (items: Settings) => Promise<void>;
};

/** The stored settings, each one its default when unset, unreadable or malformed. */
export const readSettings = async (
  storage: SettingsStorage,
): Promise<Settings> => {
  try {
    const stored = (await storage.get(DEFAULT_SETTINGS))["statusPage"];
    return {
      statusPage:
        typeof stored === "boolean" ? stored : DEFAULT_SETTINGS.statusPage,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
};

/** Whether the group holds the status page: the request's `statusPage` when given, else the setting. */
export const statusPageWanted = (
  request: Pick<SetRequest, "statusPage">,
  setting: boolean,
): boolean => request.statusPage ?? setting;
