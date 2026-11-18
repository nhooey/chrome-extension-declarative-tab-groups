// Carries out a plan's steps, in order, through the narrowed tab strip, and
// answers the `set` request with what they did. Every Chrome call that
// fails becomes a failure response; nothing throws out of `runPlan`. Each
// close, open and load is reported as it starts and ends, for the status
// page.

import { fail, succeed } from "../protocol/check.ts";
import {
  type Failure,
  failure,
  type Result,
  type SetSuccess,
} from "../protocol/index.ts";
import type { Plan } from "./plan.ts";
import type { ProgressEvent } from "./progress.ts";
import { ignoreProgress, type Report } from "./progress-store.ts";
import { activeTabOf, groupTabKind, tabsOf, tabUrl } from "./read-state.ts";
import type { NewTab, Step } from "./steps.ts";
import { type Edge, isAbandoned, messageOf } from "./tab-strip.ts";

/** How long a step retries a tab-strip change Chrome refuses while a tab is dragged. */
export const DRAG_RETRY_MS = 5_000;
/** The pause between two tries of a refused change. */
export const DRAG_RETRY_INTERVAL_MS = 100;
/** The pause between two looks at whether the opened tabs have loaded. */
export const LOAD_POLL_MS = 250;

/** The start of Chrome's message when it refuses a change while the user drags a tab. */
const DRAG_REFUSAL = "Tabs cannot be edited right now";

export const isDragRefusal = (message: string): boolean =>
  message.startsWith(DRAG_REFUSAL);

/** What the steps carried out so far have made. */
type Made = {
  readonly groupId: number | null;
  readonly windowId: number | null;
  /** The ids of the tabs opened so far, by `newTabKey`. */
  readonly opened: { readonly [key: string]: number };
  readonly loading: number;
};

const STATUS_TAB: NewTab = { role: "status" };

const newTabKey = (tab: NewTab): string =>
  tab.role === "url" ? `url ${tab.index}` : tab.role;

const internal = (message: string): Failure => failure("internal", message);

/** What a run answers once its request is given up; nobody reads it, since the request was already answered. */
const ABANDONED = internal(
  "the request passed its deadline, so its run stopped",
);

/** The URL a new tab opens; the extension's own pages name their group in their query. */
const urlOf = (edge: Edge, title: string, tab: NewTab): string =>
  tab.role === "url"
    ? tab.url
    : `${edge.pages[tab.role]}?group=${encodeURIComponent(title)}`;

/**
 * Calls Chrome, trying a change it refuses while a tab is dragged again
 * until `DRAG_RETRY_MS` after `started`, then answering `busy`; any other
 * refusal is `internal`. Once the request is given up, it calls nothing.
 */
const attempt = async <T>(
  edge: Edge,
  started: number,
  call: () => Promise<T>,
): Promise<Result<T>> => {
  if (isAbandoned(edge)) {
    return fail(ABANDONED);
  }
  try {
    return succeed(await call());
  } catch (error) {
    const message = messageOf(error);
    if (!isDragRefusal(message)) {
      return fail(internal(`Chrome refused a change: ${message}`));
    }
    if (edge.clock.now() - started >= DRAG_RETRY_MS) {
      return fail(
        failure(
          "busy",
          `Chrome refused to change the tab strip for ${DRAG_RETRY_MS / 1000} seconds, as it does while a tab is being dragged`,
        ),
      );
    }
    await edge.clock.sleep(DRAG_RETRY_INTERVAL_MS);
    return attempt(edge, started, call);
  }
};

const openedId = (made: Made, tab: NewTab): Result<number> => {
  const id = made.opened[newTabKey(tab)];
  return id === undefined
    ? fail(
        internal(`the plan names a tab it has not opened: ${newTabKey(tab)}`),
      )
    : succeed(id);
};

const known = (value: number | null, what: string): Result<number> =>
  value === null
    ? fail(internal(`the plan acts on a ${what} it has not made`))
    : succeed(value);

const withOpened = (made: Made, tab: NewTab, tabId: number): Made => ({
  ...made,
  opened: { ...made.opened, [newTabKey(tab)]: tabId },
});

/** The tabs still loading; a tab that is gone is not. */
const stillLoading = async (
  edge: Edge,
  tabIds: readonly number[],
): Promise<readonly number[]> => {
  const loading = await Promise.all(
    tabIds.map(async (tabId) => {
      try {
        return (await edge.tabStrip.tabs.get(tabId)).status !== "complete";
      } catch {
        return false;
      }
    }),
  );
  return tabIds.filter((_, index) => loading[index] === true);
};

/** An opened page being waited for: its tab, and its place in `urls`. */
type Loading = { readonly tabId: number; readonly index: number };

/** Waits for the pages to load, reporting each as it does; answers how many are still loading at the deadline. */
const waitForLoad = async (
  edge: Edge,
  report: Report,
  pages: readonly Loading[],
  deadline: number,
): Promise<number> => {
  if (isAbandoned(edge)) {
    return pages.length;
  }
  const loading = await stillLoading(
    edge,
    pages.map((page) => page.tabId),
  );
  const rest = pages.filter((page) => loading.includes(page.tabId));
  pages
    .filter((page) => !rest.includes(page))
    .forEach((page) => report({ kind: "loaded", index: page.index }));
  if (rest.length === 0) {
    return 0;
  }
  if (edge.clock.now() >= deadline) {
    rest.forEach((page) =>
      report({ kind: "load-timed-out", index: page.index }),
    );
    return rest.length;
  }
  await edge.clock.sleep(Math.min(LOAD_POLL_MS, deadline - edge.clock.now()));
  return waitForLoad(edge, report, rest, deadline);
};

/** The group's first and last tabs, which every open or move places by. */
type Call = <T>(f: () => Promise<T>) => Promise<Result<T>>;

/** How many times a tab is moved toward its place before it is left where it is. */
const PLACE_TRIES = 3;

/**
 * Puts the tab in the group, then makes it the group's first or last tab
 * by the group's tabs as they are read just before the move; the move is
 * checked by reading them again.
 */
const placeInGroup = async (
  edge: Edge,
  call: Call,
  tabId: number,
  groupId: number,
  at: "start" | "end",
  tries: number,
): Promise<Result<null>> => {
  const grouped = await call(() =>
    edge.tabStrip.tabs.group({ tabIds: tabId, groupId }),
  );
  if (!grouped.ok) return grouped;
  if (isAbandoned(edge)) return fail(ABANDONED);
  const tabs = await tabsOf(edge.tabStrip, groupId);
  const target = at === "start" ? tabs[0] : tabs.at(-1);
  if (target === undefined) {
    return fail(internal("the group has no tab to place a tab by"));
  }
  if (target.id === tabId || tries === 0) {
    return succeed(null);
  }
  const moved = await call(() =>
    edge.tabStrip.tabs.move(tabId, { index: target.index }),
  );
  return moved.ok
    ? placeInGroup(edge, call, tabId, groupId, at, tries - 1)
    : moved;
};

const exists = (edge: Edge, tabId: number): Promise<boolean> =>
  edge.tabStrip.tabs.get(tabId).then(
    () => true,
    () => false,
  );

/** Closes each of the tabs that still exists, one at a time. */
const closeEach = async (
  edge: Edge,
  call: Call,
  tabIds: readonly number[],
): Promise<Result<null>> => {
  const [tabId, ...rest] = tabIds;
  if (tabId === undefined) {
    return succeed(null);
  }
  if (isAbandoned(edge)) {
    return fail(ABANDONED);
  }
  if (await exists(edge, tabId)) {
    const closed = await call(() => edge.tabStrip.tabs.remove([tabId]));
    if (!closed.ok && (isAbandoned(edge) || (await exists(edge, tabId)))) {
      return closed;
    }
  }
  return closeEach(edge, call, rest);
};

/**
 * Makes the status page its window's active tab, only while the tab it
 * replaces is still the active one, and only when the tab is still this
 * group's status page, in the plan's window and group. It is best-effort:
 * when it cannot, Chrome picks the next active tab itself once the
 * replaced tab closes, and the request goes on. Once the request is given
 * up, it calls nothing.
 */
const activateStatusPage = async (
  edge: Edge,
  title: string,
  made: Made,
  tabId: number | null,
  replacing: number,
): Promise<void> => {
  const statusId = tabId ?? made.opened[newTabKey(STATUS_TAB)];
  const { windowId, groupId } = made;
  if (statusId === undefined || windowId === null || isAbandoned(edge)) {
    return;
  }
  try {
    if ((await activeTabOf(edge.tabStrip, windowId)) !== replacing) {
      return;
    }
    if (isAbandoned(edge)) return;
    const page = await edge.tabStrip.tabs.get(statusId);
    const ours =
      page.windowId === windowId &&
      page.groupId === groupId &&
      groupTabKind(tabUrl(page), edge.pages, title) === "status";
    if (ours && !isAbandoned(edge)) {
      await edge.tabStrip.tabs.update(statusId, { active: true });
    }
  } catch {
    // Chrome makes another tab active when the replaced one closes.
  }
};

const runStep = async (
  edge: Edge,
  title: string,
  report: Report,
  step: Step,
  made: Made,
): Promise<Result<Made>> => {
  const started = edge.clock.now();
  const call = <T>(f: () => Promise<T>): Promise<Result<T>> =>
    attempt(edge, started, f);
  switch (step.kind) {
    case "create-window": {
      const created = await call(() =>
        edge.tabStrip.windows.create({
          url: urlOf(edge, title, step.tab),
          focused: false,
          type: "normal",
        }),
      );
      if (!created.ok) return created;
      const windowId = created.value?.id;
      const tabId = created.value?.tabs?.[0]?.id;
      return windowId === undefined || tabId === undefined
        ? fail(internal("Chrome made a window without a tab"))
        : succeed(withOpened({ ...made, windowId }, step.tab, tabId));
    }
    case "open-in-window": {
      const created = await call(() =>
        edge.tabStrip.tabs.create({
          windowId: step.windowId,
          url: urlOf(edge, title, step.tab),
          active: false,
        }),
      );
      if (!created.ok) return created;
      const tabId = created.value.id;
      return tabId === undefined
        ? fail(internal("Chrome made a tab without an id"))
        : succeed(
            withOpened({ ...made, windowId: step.windowId }, step.tab, tabId),
          );
    }
    case "create-group": {
      const tabId = openedId(made, step.tab);
      if (!tabId.ok) return tabId;
      const windowId = known(made.windowId, "window");
      if (!windowId.ok) return windowId;
      const groupId = await call(() =>
        edge.tabStrip.tabs.group({
          tabIds: tabId.value,
          createProperties: { windowId: windowId.value },
        }),
      );
      if (!groupId.ok) return groupId;
      const updated = await call(() =>
        edge.tabStrip.tabGroups.update(groupId.value, {
          title: step.title,
          ...(step.color === undefined ? {} : { color: step.color }),
        }),
      );
      return updated.ok
        ? succeed({ ...made, groupId: groupId.value })
        : updated;
    }
    case "open-in-group": {
      const groupId = known(made.groupId, "group");
      if (!groupId.ok) return groupId;
      const windowId = known(made.windowId, "window");
      if (!windowId.ok) return windowId;
      // Opened at the window's end and then placed by a fresh read of the
      // group, so a tab another program or the user adds meanwhile cannot
      // put it out of order.
      const created = await call(() =>
        edge.tabStrip.tabs.create({
          windowId: windowId.value,
          url: urlOf(edge, title, step.tab),
          active: false,
        }),
      );
      if (!created.ok) return created;
      const tabId = created.value.id;
      if (tabId === undefined) {
        return fail(internal("Chrome made a tab without an id"));
      }
      const placed = await placeInGroup(
        edge,
        call,
        tabId,
        groupId.value,
        step.at,
        PLACE_TRIES,
      );
      return placed.ok ? succeed(withOpened(made, step.tab, tabId)) : placed;
    }
    case "move-first": {
      const groupId = known(made.groupId, "group");
      if (!groupId.ok) return groupId;
      const placed = await placeInGroup(
        edge,
        call,
        step.tabId,
        groupId.value,
        "start",
        PLACE_TRIES,
      );
      return placed.ok ? succeed(made) : placed;
    }
    case "activate-status-page":
      await activateStatusPage(edge, title, made, step.tabId, step.replacing);
      return succeed(made);
    case "close": {
      const closed = await call(() =>
        edge.tabStrip.tabs.remove([...step.tabIds]),
      );
      if (closed.ok || closed.error.error.code === "busy") {
        return closed.ok ? succeed(made) : closed;
      }
      // Chrome refuses the whole list when one of its tabs has gone, after
      // closing some of the rest; what still exists closes one by one.
      const each = await closeEach(edge, call, step.tabIds);
      return each.ok ? succeed(made) : each;
    }
    case "set-color":
    case "collapse": {
      const groupId = known(made.groupId, "group");
      if (!groupId.ok) return groupId;
      const updated = await call(() =>
        edge.tabStrip.tabGroups.update(
          groupId.value,
          step.kind === "collapse"
            ? { collapsed: true }
            : { color: step.color },
        ),
      );
      return updated.ok ? succeed(made) : updated;
    }
    case "wait-for-load": {
      const pages = step.tabs.map((tab): Result<Loading> => {
        if (tab.role !== "url") {
          return fail(internal(`the plan waits for the ${tab.role} page`));
        }
        const tabId = openedId(made, tab);
        return tabId.ok
          ? succeed({ tabId: tabId.value, index: tab.index })
          : tabId;
      });
      const missing = pages.find((page) => !page.ok);
      if (missing !== undefined && !missing.ok) return missing;
      const waiting = pages.flatMap((page) => (page.ok ? [page.value] : []));
      report({
        kind: "load-wait-started",
        indexes: waiting.map((page) => page.index),
      });
      const loading = await waitForLoad(
        edge,
        report,
        waiting,
        started + step.timeoutMs,
      );
      return succeed({ ...made, loading });
    }
  }
};

/** The index in `urls` of the page a step opens, if it opens one. */
const openedIndex = (step: Step): number | null =>
  (step.kind === "create-window" ||
    step.kind === "open-in-window" ||
    step.kind === "open-in-group") &&
  step.tab.role === "url"
    ? step.tab.index
    : null;

/** What is reported as a step starts, and as it ends well. */
const stepEvents = (
  step: Step,
): readonly [ProgressEvent | null, ProgressEvent | null] => {
  const index = openedIndex(step);
  return step.kind === "close"
    ? [
        { kind: "close-started", tabIds: step.tabIds },
        { kind: "closed", tabIds: step.tabIds },
      ]
    : index !== null
      ? [
          { kind: "open-started", index },
          { kind: "opened", index },
        ]
      : [null, null];
};

const runSteps = async (
  edge: Edge,
  title: string,
  report: Report,
  steps: readonly Step[],
  made: Made,
): Promise<Result<Made>> => {
  const [step, ...rest] = steps;
  if (step === undefined) {
    return succeed(made);
  }
  if (isAbandoned(edge)) {
    return fail(ABANDONED);
  }
  const [starting, ending] = stepEvents(step);
  if (starting !== null) report(starting);
  const next = await runStep(edge, title, report, step, made);
  if (!next.ok) return next;
  if (ending !== null) report(ending);
  return runSteps(edge, title, report, rest, next.value);
};

const start = (plan: Plan): Made => {
  const base = { opened: {}, loading: 0 };
  switch (plan.group.kind) {
    case "existing":
      return {
        ...base,
        groupId: plan.group.groupId,
        windowId: plan.group.windowId,
      };
    case "new":
      return { ...base, groupId: null, windowId: plan.group.windowId };
    case "new-window":
      return { ...base, groupId: null, windowId: null };
  }
};

/**
 * Carries out the plan for the group titled `title` and answers with what
 * it did, or with the failure that stopped it: `busy` when Chrome refused a
 * change for `DRAG_RETRY_MS`, else `internal`. The steps before a failure
 * stay done. Once `edge.signal` aborts, the run stops at its next step,
 * retry or poll, making no Chrome call after the one under way returns.
 * `report` is told as each close, open and load starts and ends.
 */
export const runPlan = async (
  edge: Edge,
  title: string,
  plan: Plan,
  report: Report = ignoreProgress,
): Promise<SetSuccess | Failure> => {
  try {
    const done = await runSteps(edge, title, report, plan.steps, start(plan));
    if (!done.ok) {
      return done.error;
    }
    const windowId = known(done.value.windowId, "window");
    return !windowId.ok
      ? windowId.error
      : {
          protocol: 1,
          ok: true,
          command: "set",
          group: { title, windowId: windowId.value, created: plan.created },
          opened: plan.opened,
          closed: plan.closed,
          kept: plan.kept,
          unchecked: plan.unchecked,
          loading: done.value.loading,
        };
  } catch (error) {
    return internal(`carrying out the plan failed: ${messageOf(error)}`);
  }
};
