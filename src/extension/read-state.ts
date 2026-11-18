// Reads what the planner and `get` need from Chrome through the narrowed
// tab strip. Reading never focuses anything: the last-focused window and
// each window's active tab are asked for, not changed.

import { type Color, COLORS } from "../protocol/index.ts";
import { type FormState, tabFormState } from "./form-check.ts";
import type { TabRef } from "./progress.ts";
import { ignoreProgress, type Report } from "./progress-store.ts";
import type { Group, GroupState, GroupTab, OwnPage } from "./state.ts";
import {
  type ChromeGroup,
  type ChromeTab,
  type Edge,
  type ExtensionPages,
  type TabStrip,
  within,
} from "./tab-strip.ts";

const NORMAL = { windowTypes: ["normal" as const] };

/** The page a URL shows: its scheme, host and path, without query or fragment; null when it does not parse. */
const pageOf = (url: string): string | null => {
  const parsed = URL.parse(url);
  return parsed === null
    ? null
    : `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
};

/** Whether the tab at `url` shows one of the extension's own pages, and which. */
export const tabKind = (
  url: string,
  pages: ExtensionPages,
): OwnPage | "other" => {
  const page = pageOf(url);
  return page === null
    ? "other"
    : page === pageOf(pages.status)
      ? "status"
      : page === pageOf(pages.empty)
        ? "empty"
        : "other";
};

/** The group an extension page names in its `group` query; null when it names none. */
const namedGroup = (url: string): string | null =>
  URL.parse(url)?.searchParams.get("group") ?? null;

/**
 * The kind of a tab in the group titled `title`: one of the extension's
 * own pages only when it names that group in its `group` query, such as
 * the status page of a group since renamed, or one dragged in from
 * another group, and `stray` when it names another group or none.
 */
export const groupTabKind = (
  url: string,
  pages: ExtensionPages,
  title: string,
): GroupTab["kind"] => {
  const kind = tabKind(url, pages);
  return kind === "other" || namedGroup(url) === title ? kind : "stray";
};

/** A tab's URL, or the URL it is navigating to while it has none yet. */
export const tabUrl = (tab: ChromeTab): string =>
  tab.url !== undefined && tab.url !== "" ? tab.url : (tab.pendingUrl ?? "");

const colorOf = (group: ChromeGroup): Color =>
  COLORS.find((color) => color === group.color) ?? "grey";

/** The groups titled exactly `title` among Chrome's normal windows. */
export const groupsTitled = async (
  tabStrip: TabStrip,
  title: string,
): Promise<readonly ChromeGroup[]> => {
  const [groups, windows] = await Promise.all([
    tabStrip.tabGroups.query({}),
    tabStrip.windows.getAll(NORMAL),
  ]);
  const normal = windows.flatMap((window) =>
    window.id === undefined ? [] : [window.id],
  );
  return groups.filter(
    (group) => group.title === title && normal.includes(group.windowId),
  );
};

/** The group's tabs that have an id, in tab-strip order. */
export const tabsOf = async (
  tabStrip: TabStrip,
  groupId: number,
): Promise<readonly (ChromeTab & { readonly id: number })[]> =>
  (await tabStrip.tabs.query({ groupId }))
    .flatMap((tab) => (tab.id === undefined ? [] : [{ ...tab, id: tab.id }]))
    .toSorted((left, right) => left.index - right.index);

/** How long one tab's form check may take before the tab counts as `unchecked`. */
export const FORM_CHECK_TIMEOUT_MS = 5_000;

/**
 * The form check of one tab: `unchecked` without running it on a tab that
 * is discarded, frozen or unloaded, else the fold of every frame's answer,
 * and `unchecked` when Chrome refuses to run it or it has not answered
 * within `FORM_CHECK_TIMEOUT_MS`, as with a page showing a dialog or hung.
 * It is injected at once rather than when the page is idle, which a page
 * still loading may never be.
 */
export const formStateOf = async (
  edge: Edge,
  tab: ChromeTab & { readonly id: number },
): Promise<FormState> => {
  if (tab.discarded || tab.frozen === true || tab.status === "unloaded") {
    return "unchecked";
  }
  edge.signal?.throwIfAborted();
  const check = edge.tabStrip.scripting
    .executeScript({ target: { tabId: tab.id, allFrames: true } })
    .then(tabFormState, (): FormState => "unchecked");
  return within(edge.clock, FORM_CHECK_TIMEOUT_MS, check, "unchecked");
};

/** The id of the window's active tab; null when Chrome does not say. */
export const activeTabOf = async (
  tabStrip: TabStrip,
  windowId: number,
): Promise<number | null> => {
  try {
    return (
      (await tabStrip.tabs.query({ windowId, active: true }))[0]?.id ?? null
    );
  } catch {
    return null;
  }
};

const tabRef = (tab: ChromeTab & { readonly id: number }): TabRef => ({
  id: tab.id,
  url: tabUrl(tab),
  title: tab.title ?? "",
});

/** A group's tabs and its window's active tab, before the form check. */
type Unchecked = {
  readonly group: ChromeGroup;
  readonly tabs: readonly (ChromeTab & { readonly id: number })[];
  readonly activeTabId: number | null;
};

const readUnchecked = async (
  edge: Edge,
  group: ChromeGroup,
): Promise<Unchecked> => {
  edge.signal?.throwIfAborted();
  const [tabs, activeTabId] = await Promise.all([
    tabsOf(edge.tabStrip, group.id),
    activeTabOf(edge.tabStrip, group.windowId),
  ]);
  return { group, tabs, activeTabId };
};

const groupTab = async (
  edge: Edge,
  report: Report,
  title: string,
  tab: ChromeTab & { readonly id: number },
): Promise<GroupTab> => {
  const fields = tabRef(tab);
  const kind = groupTabKind(fields.url, edge.pages, title);
  if (kind !== "other") {
    return { ...fields, kind };
  }
  const form = await formStateOf(edge, tab);
  report({ kind: "tab-checked", tabId: tab.id, form });
  return { ...fields, kind, form };
};

const checkGroup = async (
  edge: Edge,
  report: Report,
  { group, tabs, activeTabId }: Unchecked,
): Promise<Group> => {
  const title = group.title ?? "";
  return {
    id: group.id,
    title,
    color: colorOf(group),
    collapsed: group.collapsed,
    windowId: group.windowId,
    tabs: await Promise.all(
      tabs.map((tab) => groupTab(edge, report, title, tab)),
    ),
    activeTabId,
  };
};

/** The last-focused normal window's id; null when there is none. */
export const lastFocusedWindow = async (
  tabStrip: TabStrip,
): Promise<number | null> => {
  try {
    return (await tabStrip.windows.getLastFocused(NORMAL)).id ?? null;
  } catch {
    return null;
  }
};

export type ReadOptions = {
  /** Whether the group holds the status page; off when absent. */
  readonly statusPage?: boolean;
  /** Told when the form check starts and as each tab's result comes. */
  readonly report?: Report;
};

/**
 * What the planner needs for a `set` on the group titled `title`. Once
 * `edge.signal` aborts, it reads nothing more and rejects with the
 * signal's reason.
 */
export const readGroupState = async (
  edge: Edge,
  title: string,
  options: ReadOptions = {},
): Promise<GroupState> => {
  edge.signal?.throwIfAborted();
  const report = options.report ?? ignoreProgress;
  const [groups, windowId] = await Promise.all([
    groupsTitled(edge.tabStrip, title),
    lastFocusedWindow(edge.tabStrip),
  ]);
  const unchecked = await Promise.all(
    groups.map((group) => readUnchecked(edge, group)),
  );
  report({
    kind: "check-started",
    tabs: unchecked
      .flatMap(({ tabs }) => tabs.map(tabRef))
      .filter((tab) => tabKind(tab.url, edge.pages) === "other"),
  });
  return {
    groups: await Promise.all(
      unchecked.map((each) => checkGroup(edge, report, each)),
    ),
    windowId,
    statusPage: options.statusPage ?? false,
  };
};
