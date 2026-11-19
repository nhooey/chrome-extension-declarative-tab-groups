// A model of one tab group that applies a plan's steps, so that the tests
// can check every state the group passes through. A step the model cannot
// apply, such as one naming a tab that is not there, or activating a
// status page that is not in the group, throws.

import type { Color, SetRequest } from "../../src/protocol/index.ts";
import type { FormState } from "../../src/extension/form-check.ts";
import type { GroupState } from "../../src/extension/state.ts";
import type { NewTab, Step } from "../../src/extension/steps.ts";

/** A tab of the model: an existing tab by its id, or a new one by its role. */
export type ModelTab = {
  readonly key: string;
  readonly kind: "status" | "empty" | "stray" | "other";
  readonly form?: FormState;
};

export type Model = {
  /** Whether the group exists; a new group exists from its create-group step. */
  readonly exists: boolean;
  readonly tabs: readonly ModelTab[];
  /** A tab opened outside any group, waiting for create-group. */
  readonly loose: ModelTab | null;
  readonly color: Color | null;
  readonly collapsed: boolean;
};

export type Simulation = {
  /** The model after each step. */
  readonly after: readonly Model[];
  readonly final: Model;
  /** Every tab a close step closed, in order. */
  readonly closed: readonly ModelTab[];
  /** Every tab an open step opened, in order. */
  readonly opened: readonly NewTab[];
  /** Every tab a wait-for-load step waited for, in order. */
  readonly waited: readonly NewTab[];
};

export const existingKey = (id: number): string => `tab ${id}`;

export const newKey = (tab: NewTab): string =>
  tab.role === "url" ? `new url ${tab.index}` : `new ${tab.role}`;

const fresh = (tab: NewTab): ModelTab => ({
  key: newKey(tab),
  kind: tab.role === "url" ? "other" : tab.role,
});

const failStep = (step: Step, why: string): never => {
  throw new Error(`cannot apply ${JSON.stringify(step)}: ${why}`);
};

/** The model of the group titled as the request names it, before any step. */
export const initialModel = (state: GroupState, request: SetRequest): Model => {
  const group = state.groups.find((each) => each.title === request.group);
  return group === undefined
    ? { exists: false, tabs: [], loose: null, color: null, collapsed: false }
    : {
        exists: true,
        tabs: group.tabs.map((tab) => ({
          key: existingKey(tab.id),
          kind: tab.kind,
          ...(tab.kind === "other" ? { form: tab.form } : {}),
        })),
        loose: null,
        color: group.color,
        collapsed: group.collapsed,
      };
};

const apply = (model: Model, step: Step): Model => {
  switch (step.kind) {
    case "create-window":
    case "open-in-window":
      return model.exists || model.loose !== null
        ? failStep(step, "the group or a loose tab already exists")
        : { ...model, loose: fresh(step.tab) };
    case "create-group":
      return model.loose?.key !== newKey(step.tab)
        ? failStep(step, "the tab is not open")
        : {
            ...model,
            exists: true,
            tabs: [model.loose],
            loose: null,
            color: step.color ?? null,
          };
    case "open-in-group":
      return !model.exists
        ? failStep(step, "no group")
        : model.tabs.some((tab) => tab.key === newKey(step.tab))
          ? failStep(step, "the tab is already open")
          : {
              ...model,
              tabs:
                step.at === "start"
                  ? [fresh(step.tab), ...model.tabs]
                  : [...model.tabs, fresh(step.tab)],
            };
    case "move-first": {
      const key = existingKey(step.tabId);
      const moved = model.tabs.find((tab) => tab.key === key);
      return moved === undefined
        ? failStep(step, "the tab is not in the group")
        : {
            ...model,
            tabs: [moved, ...model.tabs.filter((tab) => tab !== moved)],
          };
    }
    case "activate-status-page": {
      const key =
        step.tabId === null
          ? newKey({ role: "status" })
          : existingKey(step.tabId);
      return model.tabs.some((tab) => tab.key === key && tab.kind === "status")
        ? model
        : failStep(step, "the status page is not in the group");
    }
    case "close": {
      const keys = step.tabIds.map(existingKey);
      return keys.some((key) => !model.tabs.some((tab) => tab.key === key))
        ? failStep(step, "a tab is not in the group")
        : {
            ...model,
            tabs: model.tabs.filter((tab) => !keys.includes(tab.key)),
          };
    }
    case "set-color":
      return { ...model, color: step.color };
    case "collapse":
      return { ...model, collapsed: true };
    case "wait-for-load":
      return step.tabs.every((tab) =>
        model.tabs.some((each) => each.key === newKey(tab)),
      )
        ? model
        : failStep(step, "a tab it waits for is not in the group");
  }
};

const closedBy = (model: Model, step: Step): readonly ModelTab[] =>
  step.kind === "close"
    ? model.tabs.filter((tab) => step.tabIds.map(existingKey).includes(tab.key))
    : [];

const openedBy = (step: Step): readonly NewTab[] =>
  step.kind === "create-window" ||
  step.kind === "open-in-window" ||
  step.kind === "open-in-group"
    ? [step.tab]
    : [];

export const simulate = (
  state: GroupState,
  request: SetRequest,
  steps: readonly Step[],
): Simulation => {
  const start = initialModel(state, request);
  const run = steps.reduce<{
    readonly model: Model;
    readonly after: readonly Model[];
    readonly closed: readonly ModelTab[];
    readonly opened: readonly NewTab[];
    readonly waited: readonly NewTab[];
  }>(
    (acc, step) => {
      const model = apply(acc.model, step);
      return {
        model,
        after: [...acc.after, model],
        closed: [...acc.closed, ...closedBy(acc.model, step)],
        opened: [...acc.opened, ...openedBy(step)],
        waited: [
          ...acc.waited,
          ...(step.kind === "wait-for-load" ? step.tabs : []),
        ],
      };
    },
    { model: start, after: [], closed: [], opened: [], waited: [] },
  );
  return {
    after: run.after,
    final: run.model,
    closed: run.closed,
    opened: run.opened,
    waited: run.waited,
  };
};
