// An in-memory Chrome for `narrowTabStrip` to narrow: windows, tab groups
// and tabs, with a virtual clock. It records every call with the arguments
// Chrome would receive, and behaves like Chrome where the extension
// depends on it:
//
// - ids are assigned on creation, and a tab opens loading, then completes
//   when its load time has passed on the clock;
// - a tab created between two tabs of one group joins that group, and a
//   tab added to a group goes to its end unless it is next to it already;
// - a group whose last tab closes or leaves is deleted, and a collapsed
//   group expands when a tab joins it;
// - `tabs.remove` is not atomic: it closes the tabs that exist, then
//   refuses the call when one of them did not;
// - a window has one active tab: activating a tab deactivates the rest,
//   and when the active tab closes its right-hand neighbour, else its
//   left-hand one, becomes active;
// - while "dragging", every change to the tab strip is refused with
//   Chrome's message.
//
// The clock's time passes only while every task is waiting on it: a
// sleep resolves once no other work is left, earliest first, so a Chrome
// call that answers at once always beats a timeout racing it.
//
// Beside it, fake storage areas for the settings and the progress.

import type { Color } from "../../src/protocol/index.ts";
import type { Services } from "../../src/extension/commands.ts";
import type { Progress } from "../../src/extension/progress.ts";
import type { ProgressStorage } from "../../src/extension/progress-store.ts";
import type { FrameResult } from "../../src/extension/form-check.ts";
import { EXTENSION_ID } from "../../src/extension/identity.ts";
import {
  type ChromeGroup,
  type ChromeTab,
  type ChromeTabStrip,
  type ChromeWindow,
  type Clock,
  narrowTabStrip,
} from "../../src/extension/tab-strip.ts";

export type FakeTab = {
  readonly id: number;
  readonly windowId: number;
  readonly groupId: number;
  readonly url: string;
  readonly title: string;
  readonly discarded: boolean;
  readonly frozen: boolean;
  readonly unloaded: boolean;
  readonly active: boolean;
  /** When the tab finishes loading, on the clock. */
  readonly loadsAt: number;
  /**
   * What the form check's frames answer; "refused" when Chrome refuses to
   * run it, "hang" when it never answers.
   */
  readonly frames: readonly FrameResult[] | "refused" | "hang";
};

export type FakeGroup = {
  readonly id: number;
  readonly windowId: number;
  readonly title: string;
  readonly color: Color;
  readonly collapsed: boolean;
};

export type FakeWindow = {
  readonly id: number;
  readonly type: "normal" | "popup";
  readonly focused: boolean;
  /** The window's tabs, in tab-strip order. */
  readonly tabIds: readonly number[];
};

export type World = {
  readonly windows: readonly FakeWindow[];
  readonly tabs: readonly FakeTab[];
  readonly groups: readonly FakeGroup[];
  readonly lastFocused: number | null;
  readonly nextId: number;
};

/** One call, with the arguments it was given. */
export type Call = {
  readonly operation: string;
  readonly args: readonly unknown[];
};

export const DRAG_MESSAGE =
  "Tabs cannot be edited right now (user may be dragging a tab).";

export type FakeOptions = {
  /** How long a URL takes to load; 0 when absent. */
  readonly loadMs?: (url: string) => number;
  /** Until when, on the clock, every change is refused as during a drag. */
  readonly dragUntil?: number;
  /** How many changes are refused as during a drag before they succeed. */
  readonly dragRefusals?: number;
  /** Whether the user allows the extension file URLs; false, Chrome's default, when absent. */
  readonly fileAccess?: boolean;
  /** Whether this call never answers, by its operation, such as "tabGroups.query". */
  readonly hang?: (operation: string) => boolean;
  /** How long, on the clock, this call waits before it acts and answers, by its operation; 0 when absent. */
  readonly stall?: (operation: string) => number;
  /** Changes the world just before each call, as another program or the user might. */
  readonly before?: (operation: string, w: World) => World;
};

export type Fake = {
  readonly tabStrip: ChromeTabStrip;
  readonly clock: Clock;
  readonly calls: () => readonly Call[];
  readonly world: () => World;
};

/** A world to start from: windows of tabs and groups, with ids given. */
export const world = (fields: Partial<World> = {}): World => ({
  windows: [],
  tabs: [],
  groups: [],
  lastFocused: null,
  nextId: 1000,
  ...fields,
});

export const tab = (
  id: number,
  windowId: number,
  fields: Partial<FakeTab> = {},
): FakeTab => ({
  id,
  windowId,
  groupId: -1,
  url: `https://example.com/${id}`,
  title: `Page ${id}`,
  discarded: false,
  frozen: false,
  unloaded: false,
  active: false,
  loadsAt: 0,
  frames: [{ result: false }],
  ...fields,
});

const fail = (message: string): never => {
  throw new Error(message);
};

const tabOf = (w: World, tabId: number): FakeTab =>
  w.tabs.find((each) => each.id === tabId) ?? fail(`No tab with id: ${tabId}.`);

const windowOf = (w: World, windowId: number): FakeWindow =>
  w.windows.find((each) => each.id === windowId) ??
  fail(`No window with id: ${windowId}.`);

const groupOf = (w: World, groupId: number): FakeGroup =>
  w.groups.find((each) => each.id === groupId) ??
  fail(`No group with id: ${groupId}.`);

const withTab = (w: World, changed: FakeTab): World => ({
  ...w,
  tabs: w.tabs.map((each) => (each.id === changed.id ? changed : each)),
});

const withGroup = (w: World, changed: FakeGroup): World => ({
  ...w,
  groups: w.groups.map((each) => (each.id === changed.id ? changed : each)),
});

const withStrip = (
  w: World,
  windowId: number,
  tabIds: readonly number[],
): World => ({
  ...w,
  windows: w.windows.map((each) =>
    each.id === windowId ? { ...each, tabIds } : each,
  ),
});

const insert = (
  ids: readonly number[],
  index: number,
  id: number,
): readonly number[] => {
  const at = Math.max(0, Math.min(index, ids.length));
  return [...ids.slice(0, at), id, ...ids.slice(at)];
};

/** Chrome deletes a group with no tab. */
const pruneGroups = (w: World): World => ({
  ...w,
  groups: w.groups.filter((group) =>
    w.tabs.some((each) => each.groupId === group.id),
  ),
});

/**
 * After tabs close, each window whose active tab closed makes the nearest
 * surviving tab to its right active, else the nearest to its left.
 */
const activateSuccessors = (before: World, after: World): World => {
  const successors = before.windows.flatMap((window) => {
    const strip = window.tabIds;
    const active = strip.findIndex((id) => tabOf(before, id).active);
    const survives = (id: number) => after.tabs.some((each) => each.id === id);
    if (active === -1 || survives(strip[active] ?? -1)) {
      return [];
    }
    const next =
      strip.slice(active + 1).find(survives) ??
      strip.slice(0, active).findLast(survives);
    return next === undefined ? [] : [next];
  });
  return {
    ...after,
    tabs: after.tabs.map((each) =>
      successors.includes(each.id) ? { ...each, active: true } : each,
    ),
  };
};

/** The group of both neighbours of the tab at `index`, if they share one. */
const enclosingGroup = (w: World, strip: readonly number[], index: number) => {
  const left = strip[index - 1];
  const right = strip[index + 1];
  if (left === undefined || right === undefined) {
    return -1;
  }
  const leftGroup = tabOf(w, left).groupId;
  return leftGroup !== -1 && leftGroup === tabOf(w, right).groupId
    ? leftGroup
    : -1;
};

const joinGroup = (w: World, tabId: number, groupId: number): World => {
  const group = groupOf(w, groupId);
  const moving = tabOf(w, tabId);
  if (moving.groupId === groupId) {
    return w;
  }
  if (moving.windowId !== group.windowId) {
    return fail("The fake moves no tab between windows.");
  }
  const strip = windowOf(w, group.windowId).tabIds;
  const members = strip.filter((id) => tabOf(w, id).groupId === groupId);
  const first = strip.indexOf(members[0] ?? -1);
  const last = strip.indexOf(members.at(-1) ?? -1);
  const index = strip.indexOf(tabId);
  const adjacent = index === first - 1 || index === last + 1;
  const without = strip.filter((id) => id !== tabId);
  const placed = adjacent
    ? strip
    : insert(without, without.indexOf(members.at(-1) ?? -1) + 1, tabId);
  return pruneGroups(
    withGroup(
      withTab(withStrip(w, group.windowId, placed), {
        ...moving,
        groupId,
      }),
      { ...group, collapsed: false },
    ),
  );
};

type Timer = {
  readonly at: number;
  readonly order: number;
  readonly resolve: () => void;
};

export const fakeChrome = (start: World, options: FakeOptions = {}): Fake => {
  let state = start;
  let now = 0;
  let refusals = options.dragRefusals ?? 0;
  let timers: readonly Timer[] = [];
  let ticking = false;
  let order = 0;
  const log: Call[] = [];
  const loadMs = options.loadMs ?? (() => 0);

  /** Lets the earliest timer fire once every other task has settled. */
  const schedule = (): void => {
    if (!ticking && timers.length > 0) {
      ticking = true;
      setImmediate(() => {
        ticking = false;
        const [next] = timers.toSorted(
          (left, right) => left.at - right.at || left.order - right.order,
        );
        if (next !== undefined) {
          timers = timers.filter((timer) => timer !== next);
          now = Math.max(now, next.at);
          next.resolve();
        }
        schedule();
      });
    }
  };

  const clock: Clock = {
    now: () => now,
    sleep: (milliseconds, signal) =>
      new Promise((resolve) => {
        if (signal?.aborted === true) {
          return;
        }
        const timer: Timer = { at: now + milliseconds, order, resolve };
        order += 1;
        timers = [...timers, timer];
        signal?.addEventListener(
          "abort",
          () => {
            timers = timers.filter((each) => each !== timer);
          },
          { once: true },
        );
        schedule();
      }),
  };

  const settle = <T>(f: () => T): Promise<T> => {
    try {
      return Promise.resolve(f());
    } catch (error) {
      return Promise.reject(error);
    }
  };

  /**
   * Records the call, lets `before` change the world, then answers, never
   * when the operation hangs, or after its stall when it stalls.
   */
  const answer = <T>(
    operation: string,
    args: readonly unknown[],
    f: () => T,
  ): Promise<T> => {
    log.push({ operation, args });
    state = options.before?.(operation, state) ?? state;
    if (options.hang?.(operation) === true) {
      return new Promise(() => undefined);
    }
    const stall = options.stall?.(operation) ?? 0;
    return stall > 0 ? clock.sleep(stall).then(() => settle(f)) : settle(f);
  };

  /** A change to the tab strip, unless a drag refuses it. */
  const change = <T>(
    operation: string,
    args: readonly unknown[],
    f: (w: World) => readonly [World, T],
  ): Promise<T> =>
    answer(operation, args, () => {
      if (now < (options.dragUntil ?? -1) || refusals > 0) {
        refusals = Math.max(0, refusals - 1);
        return fail(DRAG_MESSAGE);
      }
      const [next, result] = f(state);
      state = next;
      return result;
    });

  const view = (w: World, each: FakeTab): ChromeTab => ({
    id: each.id,
    index: windowOf(w, each.windowId).tabIds.indexOf(each.id),
    windowId: each.windowId,
    groupId: each.groupId,
    url: each.url,
    title: each.title,
    status: each.unloaded
      ? "unloaded"
      : now >= each.loadsAt
        ? "complete"
        : "loading",
    discarded: each.discarded,
    frozen: each.frozen,
  });

  const windowView = (w: World, each: FakeWindow): ChromeWindow => ({
    id: each.id,
    tabs: each.tabIds.map((id) => view(w, tabOf(w, id))),
  });

  const newTab = (
    w: World,
    windowId: number,
    url: string,
    active: boolean,
  ): FakeTab => ({
    ...tab(w.nextId, windowId),
    url,
    title: url,
    active,
    loadsAt: now + loadMs(url),
  });

  const removeTabs = (w: World, tabIds: readonly number[]): World =>
    pruneGroups(
      activateSuccessors(w, {
        ...w,
        tabs: w.tabs.filter((each) => !tabIds.includes(each.id)),
        windows: w.windows.map((each) => ({
          ...each,
          tabIds: each.tabIds.filter((id) => !tabIds.includes(id)),
        })),
      }),
    );

  const tabStrip: ChromeTabStrip = {
    tabs: {
      query: (query) =>
        answer("tabs.query", [query], () =>
          state.tabs
            .filter((each) =>
              "groupId" in query
                ? each.groupId === query.groupId
                : each.windowId === query.windowId && each.active,
            )
            .map((each) => view(state, each)),
        ),
      get: (tabId) =>
        answer("tabs.get", [tabId], () => view(state, tabOf(state, tabId))),
      create: (properties) =>
        answer("tabs.create", [properties], () => {
          const strip = windowOf(state, properties.windowId).tabIds;
          const created = newTab(
            state,
            properties.windowId,
            properties.url,
            properties.active,
          );
          const placed = insert(
            strip,
            properties.index ?? strip.length,
            created.id,
          );
          const added = withStrip(
            {
              ...state,
              tabs: [...state.tabs, created],
              nextId: state.nextId + 1,
            },
            properties.windowId,
            placed,
          );
          const groupId = enclosingGroup(
            added,
            placed,
            placed.indexOf(created.id),
          );
          state = withTab(added, { ...created, groupId });
          return view(state, tabOf(state, created.id));
        }),
      group: (options) =>
        change("tabs.group", [options], (w) => {
          if ("groupId" in options) {
            return [
              joinGroup(w, options.tabIds, options.groupId),
              options.groupId,
            ];
          }
          const grouped = tabOf(w, options.tabIds);
          const windowId = options.createProperties.windowId;
          if (grouped.windowId !== windowId) {
            return fail("The fake moves no tab between windows.");
          }
          const group: FakeGroup = {
            id: w.nextId,
            windowId,
            title: "",
            color: "grey",
            collapsed: false,
          };
          return [
            pruneGroups(
              withTab(
                { ...w, groups: [...w.groups, group], nextId: w.nextId + 1 },
                { ...grouped, groupId: group.id },
              ),
            ),
            group.id,
          ];
        }),
      move: (tabId, properties) =>
        change("tabs.move", [tabId, properties], (w) => {
          const moving = tabOf(w, tabId);
          const strip = windowOf(w, moving.windowId).tabIds.filter(
            (id) => id !== tabId,
          );
          const placed = insert(strip, properties.index, tabId);
          const moved = withStrip(w, moving.windowId, placed);
          const index = placed.indexOf(tabId);
          const enclosing = enclosingGroup(moved, placed, index);
          const neighbours = [placed[index - 1], placed[index + 1]].flatMap(
            (id) => (id === undefined ? [] : [tabOf(moved, id).groupId]),
          );
          const groupId =
            enclosing !== -1
              ? enclosing
              : neighbours.includes(moving.groupId)
                ? moving.groupId
                : -1;
          return [pruneGroups(withTab(moved, { ...moving, groupId })), null];
        }),
      remove: (tabIds) =>
        change("tabs.remove", [tabIds], (w) => {
          const missing = tabIds.find(
            (id) => !w.tabs.some((each) => each.id === id),
          );
          if (missing !== undefined) {
            // Not atomic: the tabs that exist close before the refusal.
            state = removeTabs(w, tabIds);
            return fail(`No tab with id: ${missing}.`);
          }
          return [removeTabs(w, tabIds), undefined];
        }),
      update: (tabId, properties) =>
        change("tabs.update", [tabId, properties], (w) => {
          const activated = tabOf(w, tabId);
          return [
            {
              ...w,
              tabs: w.tabs.map((each) =>
                each.windowId === activated.windowId
                  ? { ...each, active: each.id === tabId }
                  : each,
              ),
            },
            view(w, activated),
          ];
        }),
    },
    tabGroups: {
      query: (query) =>
        answer(
          "tabGroups.query",
          [query],
          (): readonly ChromeGroup[] => state.groups,
        ),
      update: (groupId, properties) =>
        change("tabGroups.update", [groupId, properties], (w) => {
          const group = groupOf(w, groupId);
          return [withGroup(w, { ...group, ...properties }), null];
        }),
    },
    windows: {
      getAll: (options) =>
        answer("windows.getAll", [options], () =>
          state.windows
            .filter((each) =>
              options.windowTypes.includes(each.type as "normal"),
            )
            .map((each) => windowView(state, each)),
        ),
      getLastFocused: (options) =>
        answer("windows.getLastFocused", [options], () => {
          const last = state.windows.find(
            (each) => each.id === state.lastFocused && each.type === "normal",
          );
          return last === undefined
            ? fail("No last-focused window")
            : windowView(state, last);
        }),
      create: (data) =>
        answer("windows.create", [data], () => {
          const windowId = state.nextId;
          const created = newTab(
            { ...state, nextId: windowId + 1 },
            windowId,
            data.url,
            true,
          );
          const window: FakeWindow = {
            id: windowId,
            type: data.type,
            focused: data.focused,
            tabIds: [created.id],
          };
          state = {
            ...state,
            windows: [...state.windows, window],
            tabs: [...state.tabs, created],
            lastFocused: data.focused ? windowId : state.lastFocused,
            nextId: windowId + 2,
          };
          return windowView(state, window);
        }),
    },
    scripting: {
      executeScript: (injection) => {
        const frames = state.tabs.find(
          (each) => each.id === injection.target.tabId,
        )?.frames;
        return frames === "hang"
          ? answer("scripting.executeScript", [injection], () => null).then(
              () => new Promise<readonly FrameResult[]>(() => undefined),
            )
          : answer("scripting.executeScript", [injection], () =>
              frames === undefined || frames === "refused"
                ? fail("Cannot access contents of the page.")
                : frames,
            );
      },
    },
    extension: {
      isAllowedFileSchemeAccess: () =>
        answer(
          "extension.isAllowedFileSchemeAccess",
          [],
          () => options.fileAccess ?? false,
        ),
    },
  };

  return {
    tabStrip,
    clock,
    calls: () => [...log],
    world: () => state,
  };
};

/** The empty page's URL, as `chrome.runtime.getURL` gives it. */
export const EMPTY_PAGE = `chrome-extension://${EXTENSION_ID}/empty.html`;

/** The status page's URL, as `chrome.runtime.getURL` gives it. */
export const STATUS_PAGE = `chrome-extension://${EXTENSION_ID}/status.html`;

/** An in-memory `chrome.storage.session`, recording every write. */
export type FakeSession = {
  readonly storage: ProgressStorage;
  readonly writes: () => readonly {
    readonly key: string;
    readonly value: Progress;
  }[];
};

export type SessionOptions = {
  /** What the storage holds at the start, as a stopped worker left it. */
  readonly items?: { readonly [key: string]: unknown };
  /** Which calls reject, or never answer; none when absent. */
  readonly reject?: "get" | "set" | "both";
  readonly hang?: "get" | "set" | "both";
  /** How many microtask turns a read of every item takes; 0 when absent. */
  readonly slowReadAll?: number;
};

/** Resolves after `turns` microtask turns, before any timer or I/O. */
const later = (turns: number): Promise<void> =>
  turns <= 0
    ? Promise.resolve()
    : Promise.resolve().then(() => later(turns - 1));

export const fakeSession = (options: SessionOptions = {}): FakeSession => {
  const items = new Map<string, unknown>(Object.entries(options.items ?? {}));
  const writes: { readonly key: string; readonly value: Progress }[] = [];
  const fault = (call: "get" | "set"): Promise<never> | null =>
    options.hang === call || options.hang === "both"
      ? new Promise(() => undefined)
      : options.reject === call || options.reject === "both"
        ? Promise.reject(new Error(`the session storage refused a ${call}`))
        : null;
  return {
    storage: {
      get: (key) =>
        fault("get") ??
        (key === null
          ? later(options.slowReadAll ?? 0).then(() =>
              Object.fromEntries(items),
            )
          : Promise.resolve(items.has(key) ? { [key]: items.get(key) } : {})),
      set: (written) =>
        fault("set") ??
        (() => {
          Object.entries(written).forEach(([key, value]) => {
            items.set(key, value);
            writes.push({ key, value });
          });
          return Promise.resolve();
        })(),
    },
    writes: () => [...writes],
  };
};

/** Lets every write a report has started land, as reports never wait on them. */
export const settled = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

export type ServiceOptions = {
  /** The stored setting; absent when the user never changed it. */
  readonly statusPage?: boolean;
  readonly session?: FakeSession;
};

/** The commands' services over the fake, reached through `narrowTabStrip` as the worker reaches Chrome. */
export const servicesOf = (
  fake: Fake,
  options: ServiceOptions = {},
): Services => ({
  tabStrip: narrowTabStrip(fake.tabStrip),
  clock: fake.clock,
  pages: { empty: EMPTY_PAGE, status: STATUS_PAGE },
  versions: () => Promise.resolve({ extension: "0.1.0", chrome: "142.0.1.2" }),
  settings: {
    get: (defaults) =>
      Promise.resolve(
        options.statusPage === undefined
          ? defaults
          : { ...defaults, statusPage: options.statusPage },
      ),
    set: () => Promise.reject(new Error("the commands never write a setting")),
  },
  progress: (options.session ?? fakeSession()).storage,
});

/** The tabs of the group titled `title`, in tab-strip order. */
export const groupTabs = (w: World, title: string): readonly FakeTab[] => {
  const group = w.groups.find((each) => each.title === title);
  if (group === undefined) {
    return [];
  }
  return windowOf(w, group.windowId)
    .tabIds.map((id) => tabOf(w, id))
    .filter((each) => each.groupId === group.id);
};
