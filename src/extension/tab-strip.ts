// The one way the extension's code reaches Chrome's tabs, windows, groups
// and scripts: `TabStrip`, a narrowed interface naming exactly the Chrome
// operations the extension needs, with Chrome's names and shapes. None of
// them can focus: it has no `windows.update`, `tabs.update` or
// `tabs.highlight`, `tabs.create` takes only `active: false`, and
// `windows.create` only `focused: false`. The service worker hands Chrome
// itself to `narrowTabStrip`, which type-checks Chrome against the
// interface and keeps only these operations and their named fields.

import type { Color } from "../protocol/index.ts";
import { type FrameResult, hasUnsubmittedForm } from "./form-check.ts";

/** The fields of a `chrome.tabs.Tab` the extension reads. */
export type ChromeTab = {
  readonly id?: number | undefined;
  readonly index: number;
  readonly windowId: number;
  readonly groupId: number;
  readonly url?: string | undefined;
  readonly pendingUrl?: string | undefined;
  readonly title?: string | undefined;
  readonly status?: string | undefined;
  readonly discarded: boolean;
  /** Whether Chrome froze the tab; absent before Chrome 132. */
  readonly frozen?: boolean | undefined;
};

/** The fields of a `chrome.tabGroups.TabGroup` the extension reads. */
export type ChromeGroup = {
  readonly id: number;
  readonly title?: string | undefined;
  readonly color: string;
  readonly collapsed: boolean;
  readonly windowId: number;
};

/** The fields of a `chrome.windows.Window` the extension reads. */
export type ChromeWindow = {
  readonly id?: number | undefined;
  readonly tabs?: readonly ChromeTab[] | undefined;
};

type NormalWindows = { windowTypes: "normal"[] };

export type TabStrip = {
  readonly tabs: {
    readonly query: (query: {
      groupId: number;
    }) => Promise<readonly ChromeTab[]>;
    readonly get: (tabId: number) => Promise<ChromeTab>;
    readonly create: (properties: {
      windowId: number;
      url: string;
      index?: number;
      active: false;
    }) => Promise<ChromeTab>;
    readonly group: (
      options:
        | { tabIds: number; groupId: number }
        | { tabIds: number; createProperties: { windowId: number } },
    ) => Promise<number>;
    readonly move: (
      tabId: number,
      properties: { index: number },
    ) => Promise<unknown>;
    readonly remove: (tabIds: number[]) => Promise<void>;
  };
  readonly tabGroups: {
    readonly query: (
      query: Record<never, never>,
    ) => Promise<readonly ChromeGroup[]>;
    readonly update: (
      groupId: number,
      properties: { title?: string; color?: Color; collapsed?: boolean },
    ) => Promise<unknown>;
  };
  readonly windows: {
    readonly getAll: (
      options: NormalWindows,
    ) => Promise<readonly ChromeWindow[]>;
    readonly getLastFocused: (options: NormalWindows) => Promise<ChromeWindow>;
    readonly create: (data: {
      url: string;
      focused: false;
      type: "normal";
    }) => Promise<ChromeWindow | undefined>;
  };
  readonly scripting: {
    /** Runs the form check, `hasUnsubmittedForm`, in every frame of the tab; it injects nothing else. */
    readonly executeScript: (injection: {
      target: { tabId: number; allFrames: true };
    }) => Promise<readonly FrameResult[]>;
  };
  readonly extension: {
    /** Whether the user allows the extension file URLs, which `tabs.create` needs to open one. */
    readonly isAllowedFileSchemeAccess: () => Promise<boolean>;
  };
};

/**
 * What `narrowTabStrip` needs of Chrome: the same operations, with
 * `scripting.executeScript` taking the function to inject, as Chrome's does.
 */
export type ChromeTabStrip = Omit<TabStrip, "scripting"> & {
  readonly scripting: {
    readonly executeScript: (injection: {
      target: { tabId: number; allFrames: true };
      func: () => boolean;
      injectImmediately: true;
    }) => Promise<readonly FrameResult[]>;
  };
};

/**
 * A `TabStrip` holding only the interface's operations, each calling the
 * same operation of `source` with arguments built from the interface's
 * named fields alone, and injecting only the form check: whatever a caller
 * passes, nothing of Chrome outside the interface is reachable through it.
 */
export const narrowTabStrip = (source: ChromeTabStrip): TabStrip => ({
  tabs: {
    query: (query) => source.tabs.query({ groupId: query.groupId }),
    get: (tabId) => source.tabs.get(tabId),
    create: (properties) =>
      source.tabs.create({
        windowId: properties.windowId,
        url: properties.url,
        ...(properties.index === undefined ? {} : { index: properties.index }),
        active: false,
      }),
    group: (options) =>
      source.tabs.group(
        "groupId" in options
          ? { tabIds: options.tabIds, groupId: options.groupId }
          : {
              tabIds: options.tabIds,
              createProperties: {
                windowId: options.createProperties.windowId,
              },
            },
      ),
    move: (tabId, properties) =>
      source.tabs.move(tabId, { index: properties.index }),
    remove: (tabIds) => source.tabs.remove([...tabIds]),
  },
  tabGroups: {
    query: () => source.tabGroups.query({}),
    update: (groupId, properties) =>
      source.tabGroups.update(groupId, {
        ...(properties.title === undefined ? {} : { title: properties.title }),
        ...(properties.color === undefined ? {} : { color: properties.color }),
        ...(properties.collapsed === undefined
          ? {}
          : { collapsed: properties.collapsed }),
      }),
  },
  windows: {
    getAll: () => source.windows.getAll({ windowTypes: ["normal"] }),
    getLastFocused: () =>
      source.windows.getLastFocused({ windowTypes: ["normal"] }),
    create: (data) =>
      source.windows.create({ url: data.url, focused: false, type: "normal" }),
  },
  scripting: {
    executeScript: (injection) =>
      source.scripting.executeScript({
        target: { tabId: injection.target.tabId, allFrames: true },
        func: hasUnsubmittedForm,
        injectImmediately: true,
      }),
  },
  extension: {
    isAllowedFileSchemeAccess: () =>
      source.extension.isAllowedFileSchemeAccess(),
  },
});

/** Time, for delays and timeouts; a test passes a clock that never waits. */
export type Clock = {
  readonly now: () => number;
  /** Resolves after `milliseconds`, or never once `signal` aborts. */
  readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

/**
 * The work's value, or `fallback` once `milliseconds` pass on the clock
 * first; work that has not settled by then is left to finish unheeded.
 */
export const within = async <T>(
  clock: Clock,
  milliseconds: number,
  work: Promise<T>,
  fallback: T,
): Promise<T> => {
  const timer = new AbortController();
  try {
    return await Promise.race([
      work,
      clock.sleep(milliseconds, timer.signal).then(() => fallback),
    ]);
  } finally {
    timer.abort();
  }
};

/** The URLs of the extension's own pages, from `chrome.runtime.getURL`. */
export type ExtensionPages = { readonly empty: string };

/** What the extension's commands act through. */
export type Edge = {
  readonly tabStrip: TabStrip;
  readonly clock: Clock;
  readonly pages: ExtensionPages;
  /**
   * Aborts once the request being served is given up at its deadline;
   * from then on its run calls Chrome no more.
   */
  readonly signal?: AbortSignal | undefined;
};

/** Whether the request the edge serves has been given up. */
export const isAbandoned = (edge: Edge): boolean =>
  edge.signal?.aborted === true;

/** The message of whatever a Chrome call rejected with. */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
