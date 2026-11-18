// Reads what the planner and `get` need from Chrome through the narrowed
// tab strip. Reading never focuses anything: the last-focused window is
// asked for, not changed.

import { type Color, COLORS } from "../protocol/index.ts";
import { type FormState, tabFormState } from "./form-check.ts";
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
  return page !== null && page === pageOf(pages.empty) ? "empty" : "other";
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

const groupTab = async (
  edge: Edge,
  tab: ChromeTab & { readonly id: number },
): Promise<GroupTab> => {
  const url = tabUrl(tab);
  const fields = { id: tab.id, url, title: tab.title ?? "" };
  const kind = tabKind(url, edge.pages);
  return kind === "other"
    ? { ...fields, kind, form: await formStateOf(edge, tab) }
    : { ...fields, kind };
};

const readGroup = async (edge: Edge, group: ChromeGroup): Promise<Group> => {
  edge.signal?.throwIfAborted();
  const tabs = await tabsOf(edge.tabStrip, group.id);
  return {
    id: group.id,
    title: group.title ?? "",
    color: colorOf(group),
    collapsed: group.collapsed,
    windowId: group.windowId,
    tabs: await Promise.all(tabs.map((tab) => groupTab(edge, tab))),
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

/**
 * What the planner needs for a `set` on the group titled `title`, with the
 * status page off. Once `edge.signal` aborts, it reads nothing more and
 * rejects with the signal's reason.
 */
export const readGroupState = async (
  edge: Edge,
  title: string,
): Promise<GroupState> => {
  edge.signal?.throwIfAborted();
  const [groups, windowId] = await Promise.all([
    groupsTitled(edge.tabStrip, title),
    lastFocusedWindow(edge.tabStrip),
  ]);
  return {
    groups: await Promise.all(groups.map((group) => readGroup(edge, group))),
    windowId,
    statusPage: false,
  };
};
