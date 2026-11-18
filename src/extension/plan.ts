// Turns a group's state and a `set` request into the steps that make the
// group hold exactly the requested pages. Pure: Chrome is read before and
// the steps are carried out after, elsewhere.

import { fail, quote, succeed } from "../protocol/check.ts";
import {
  failure,
  type Result,
  type SetRequest,
  type Tab,
} from "../protocol/index.ts";
import type { Group, GroupState, GroupTab } from "./state.ts";
import { LOAD_TIMEOUT_MS, type NewTab, type Step } from "./steps.ts";

/** The group a plan acts on. */
export type PlanGroup =
  | {
      readonly kind: "existing";
      readonly groupId: number;
      readonly windowId: number;
    }
  /** A group the plan creates in an existing window. */
  | { readonly kind: "new"; readonly windowId: number }
  /** A group the plan creates in a window it creates. */
  | { readonly kind: "new-window" };

export type Plan = {
  readonly group: PlanGroup;
  readonly steps: readonly Step[];
  readonly created: boolean;
  /** Pages of `urls` the plan opens. */
  readonly opened: number;
  /** Other pages the plan closes, not the extension's own. */
  readonly closed: number;
  /** Tabs left open because they hold an unsubmitted form, in order. */
  readonly kept: readonly Tab[];
  /** Closed tabs the form check could not run on. */
  readonly unchecked: number;
};

const STATUS: NewTab = { role: "status" };
const EMPTY: NewTab = { role: "empty" };

const urlTabs = (urls: readonly string[]): readonly NewTab[] =>
  urls.map((url, index) => ({ role: "url", index, url }));

const isUnsubmitted = (tab: GroupTab): boolean =>
  tab.kind === "other" && tab.form === "unsubmitted";

const waitFor = (tabs: readonly NewTab[]): readonly Step[] =>
  tabs.length === 0
    ? []
    : [{ kind: "wait-for-load", tabs, timeoutMs: LOAD_TIMEOUT_MS }];

const openAtEnd = (tab: NewTab): Step => ({
  kind: "open-in-group",
  tab,
  at: "end",
});

const planNewGroup = (state: GroupState, request: SetRequest): Result<Plan> => {
  const pages = urlTabs(request.urls);
  const opening = state.statusPage ? [STATUS, ...pages] : pages;
  const first = opening[0] ?? EMPTY;
  const placed: readonly [PlanGroup, Step] | null =
    state.windowId !== null
      ? [
          { kind: "new", windowId: state.windowId },
          { kind: "open-in-window", windowId: state.windowId, tab: first },
        ]
      : request.createWindow === true
        ? [{ kind: "new-window" }, { kind: "create-window", tab: first }]
        : null;
  if (placed === null) {
    return fail(
      failure(
        "no-window",
        `no Chrome window can hold the new group ${quote(request.group)}, and "createWindow" is not true`,
      ),
    );
  }
  const [group, place] = placed;
  return succeed({
    group,
    steps: [
      place,
      {
        kind: "create-group",
        tab: first,
        title: request.group,
        ...(request.color === undefined ? {} : { color: request.color }),
      },
      ...opening.slice(1).map(openAtEnd),
      ...waitFor(pages),
    ],
    created: true,
    opened: pages.length,
    closed: 0,
    kept: [],
    unchecked: 0,
  });
};

const planExistingGroup = (
  group: Group,
  statusPage: boolean,
  request: SetRequest,
): Plan => {
  const pages = urlTabs(request.urls);
  const kept = group.tabs.filter(isUnsubmitted);
  // The status page that stays, and the empty page that stays when the
  // group would otherwise hold nothing; a duplicate of either goes.
  const status = statusPage
    ? group.tabs.find((tab) => tab.kind === "status")
    : undefined;
  const empty =
    !statusPage && kept.length === 0 && pages.length === 0
      ? group.tabs.find((tab) => tab.kind === "empty")
      : undefined;
  const leaving = group.tabs.filter(
    (tab) => tab !== status && tab !== empty && !isUnsubmitted(tab),
  );
  const appended =
    pages.length > 0 || statusPage || kept.length > 0 || empty !== undefined
      ? pages
      : [EMPTY];
  // Chrome deletes a group when its last tab closes, so when nothing that
  // stays is in the group yet, its last leaving tab stays until the first
  // new tab is in.
  const keeper =
    statusPage || kept.length > 0 || empty !== undefined
      ? undefined
      : leaving.at(-1);
  const closing = leaving.filter((tab) => tab !== keeper);
  const placeStatus: readonly Step[] = !statusPage
    ? []
    : status === undefined
      ? [{ kind: "open-in-group", tab: STATUS, at: "start" }]
      : group.tabs[0]?.id !== status.id
        ? [{ kind: "move-first", tabId: status.id }]
        : [];
  const opens = appended.map(openAtEnd);
  const closed = leaving.filter((tab) => tab.kind === "other");
  return {
    group: { kind: "existing", groupId: group.id, windowId: group.windowId },
    steps: [
      ...(request.color !== undefined && request.color !== group.color
        ? [{ kind: "set-color", color: request.color } as const]
        : []),
      ...placeStatus,
      ...(closing.length > 0
        ? [{ kind: "close", tabIds: closing.map((tab) => tab.id) } as const]
        : []),
      ...opens.slice(0, 1),
      ...(keeper === undefined
        ? []
        : [{ kind: "close", tabIds: [keeper.id] } as const]),
      ...opens.slice(1),
      ...(group.collapsed ? [{ kind: "collapse" } as const] : []),
      ...waitFor(pages),
    ],
    created: false,
    opened: pages.length,
    closed: closed.length,
    kept: kept.map(({ url, title }) => ({ url, title })),
    unchecked: closed.filter(
      (tab) => tab.kind === "other" && tab.form === "unchecked",
    ).length,
  };
};

/**
 * The steps that make the group titled `request.group` hold exactly the
 * requested pages, with what the response reports, or the failure to
 * answer: `ambiguous-group` when two or more groups have the title, and
 * `no-window` when a new group has no window to go in.
 */
export const plan = (state: GroupState, request: SetRequest): Result<Plan> => {
  const matching = state.groups.filter(
    (group) => group.title === request.group,
  );
  const [group, ...others] = matching;
  if (others.length > 0) {
    return fail(
      failure(
        "ambiguous-group",
        `${matching.length} tab groups are titled ${quote(request.group)}`,
      ),
    );
  }
  return group === undefined
    ? planNewGroup(state, request)
    : succeed(planExistingGroup(group, state.statusPage, request));
};
