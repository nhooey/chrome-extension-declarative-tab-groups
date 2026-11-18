// The progress of one group, as its status page shows it: the request under
// way, as a checklist of stages each holding a line per tab or URL, and the
// latest finished request as the log. `advance` folds the events the
// service worker's edge emits into it. Pure: no Chrome, no clock, no I/O.

import type {
  ErrorCode,
  Failure,
  SetRequest,
  SetSuccess,
} from "../protocol/index.ts";
import type { FormState } from "./form-check.ts";
import type { Plan } from "./plan.ts";
import type { GroupState } from "./state.ts";

/** A line's state: not reached, under way, or one of its four endings. */
export type LineState =
  "waiting" | "running" | "done" | "kept" | "unchecked" | "failed";

export type Line = {
  /** Unique within its stage: `tab <id>` or `url <index>`. */
  readonly key: string;
  readonly label: string;
  readonly state: LineState;
  /** Why it ended as it did, when the state alone does not say. */
  readonly note?: string;
};

/** The checklist's stages, in the order a request goes through them. */
export const STAGE_KINDS = ["check", "close", "open", "load"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

export type Stage = {
  readonly kind: StageKind;
  readonly state: LineState;
  readonly lines: readonly Line[];
};

/** How a request ended: what its response reported, or its failure. */
export type Outcome =
  | {
      readonly ok: true;
      readonly opened: number;
      readonly closed: number;
      readonly kept: number;
      readonly unchecked: number;
      readonly loading: number;
    }
  | {
      readonly ok: false;
      readonly code: ErrorCode;
      readonly message: string;
    };

/** One `set` request on the group. */
export type Run = {
  readonly urls: readonly string[];
  readonly startedAt: number;
  /** One stage of each kind, in `STAGE_KINDS` order. */
  readonly stages: readonly Stage[];
  readonly finishedAt: number | null;
  readonly outcome: Outcome | null;
};

export type Progress = {
  readonly group: string;
  /** The request under way; null while the group is idle. */
  readonly current: Run | null;
  /** The latest finished request; null once the next one starts. */
  readonly log: Run | null;
  /** How many pages the group holds after its last request; null when unknown, as after a failure. */
  readonly pages: number | null;
  /** When the group was last set; null when it has not been since Chrome started. */
  readonly setAt: number | null;
};

/** A tab as a line names it. */
export type TabRef = {
  readonly id: number;
  readonly url: string;
  readonly title: string;
};

/** What happened, in the order it happens; the edge emits each one. */
export type ProgressEvent =
  | {
      readonly kind: "request-started";
      readonly at: number;
      readonly urls: readonly string[];
    }
  /** The unsubmitted-form check starts on these tabs, all at once. */
  | { readonly kind: "check-started"; readonly tabs: readonly TabRef[] }
  | {
      readonly kind: "tab-checked";
      readonly tabId: number;
      readonly form: FormState;
    }
  /** The plan is made: these tabs will close. */
  | { readonly kind: "planned"; readonly closing: readonly TabRef[] }
  | { readonly kind: "close-started"; readonly tabIds: readonly number[] }
  | { readonly kind: "closed"; readonly tabIds: readonly number[] }
  | { readonly kind: "open-started"; readonly index: number }
  | { readonly kind: "opened"; readonly index: number }
  | { readonly kind: "load-wait-started"; readonly indexes: readonly number[] }
  | { readonly kind: "loaded"; readonly index: number }
  | { readonly kind: "load-timed-out"; readonly index: number }
  | {
      readonly kind: "request-finished";
      readonly at: number;
      readonly outcome: Outcome;
    };

/** A group no request has been seen on. */
export const idle = (group: string): Progress => ({
  group,
  current: null,
  log: null,
  pages: null,
  setAt: null,
});

/** 0 for waiting, 1 for running, 2 for any ending: a line only moves up. */
const rank = (state: LineState): number =>
  state === "waiting" ? 0 : state === "running" ? 1 : 2;

export const isFinished = (state: LineState): boolean => rank(state) === 2;

const toward = (line: Line, state: LineState, note?: string): Line =>
  rank(state) > rank(line.state)
    ? { ...line, state, ...(note === undefined ? {} : { note }) }
    : line;

/** A stage's state from its lines; it never moves back either. */
const settle = (stage: Stage): Stage => {
  const states = stage.lines.map((line) => line.state);
  const derived: LineState =
    states.length === 0
      ? stage.state
      : states.every(isFinished)
        ? states.includes("failed")
          ? "failed"
          : "done"
        : states.some((state) => state !== "waiting")
          ? "running"
          : "waiting";
  return rank(derived) > rank(stage.state)
    ? { ...stage, state: derived }
    : stage;
};

const tabLine = (tab: TabRef, state: LineState): Line => ({
  key: `tab ${tab.id}`,
  label: tab.title !== "" ? tab.title : tab.url,
  state,
});

const urlLine = (url: string, index: number): Line => ({
  key: `url ${index}`,
  label: url,
  state: "waiting",
});

const urlKey = (index: number): string => `url ${index}`;
const tabKey = (id: number): string => `tab ${id}`;

const onStage = (
  run: Run,
  kind: StageKind,
  change: (stage: Stage) => Stage,
): Run => ({
  ...run,
  stages: run.stages.map((stage) =>
    stage.kind === kind ? settle(change(stage)) : stage,
  ),
});

const onLines = (
  run: Run,
  kind: StageKind,
  keys: readonly string[],
  state: LineState,
  note?: string,
): Run =>
  onStage(run, kind, (stage) => ({
    ...stage,
    lines: stage.lines.map((line) =>
      keys.includes(line.key) ? toward(line, state, note) : line,
    ),
  }));

/** A stage with nothing to do is done once the request reaches it. */
const doneIfEmpty = (stage: Stage): Stage =>
  stage.lines.length === 0 && !isFinished(stage.state)
    ? { ...stage, state: "done" }
    : stage;

const FORM_LINE: { readonly [F in FormState]: LineState } = {
  clean: "done",
  unsubmitted: "kept",
  unchecked: "unchecked",
};

const newRun = (at: number, urls: readonly string[]): Run => ({
  urls,
  startedAt: at,
  stages: STAGE_KINDS.map((kind) => ({
    kind,
    state: "waiting",
    lines: kind === "open" || kind === "load" ? urls.map(urlLine) : [],
  })),
  finishedAt: null,
  outcome: null,
});

/** Ends a run: on failure, what was under way failed and the rest was never reached. */
const finish = (run: Run, at: number, outcome: Outcome): Run => ({
  ...run,
  finishedAt: at,
  outcome,
  stages: outcome.ok
    ? run.stages.map(doneIfEmpty)
    : run.stages.map((stage) => ({
        kind: stage.kind,
        state: stage.state === "running" ? "failed" : stage.state,
        lines: stage.lines.map((line) =>
          line.state === "running" ? { ...line, state: "failed" } : line,
        ),
      })),
});

const step = (run: Run, event: ProgressEvent): Run => {
  switch (event.kind) {
    case "request-started":
    case "request-finished":
      return run;
    case "check-started":
      return onStage(run, "check", (stage) =>
        doneIfEmpty({
          ...stage,
          lines: [
            ...stage.lines,
            ...event.tabs
              .filter(
                (tab) =>
                  !stage.lines.some((line) => line.key === tabKey(tab.id)),
              )
              .map((tab) => tabLine(tab, "running")),
          ],
        }),
      );
    case "tab-checked":
      return onLines(
        run,
        "check",
        [tabKey(event.tabId)],
        FORM_LINE[event.form],
      );
    case "planned": {
      const checked = onStage(run, "check", doneIfEmpty);
      const closing = onStage(checked, "close", (stage) =>
        doneIfEmpty({
          ...stage,
          lines: event.closing.map((tab) => tabLine(tab, "waiting")),
        }),
      );
      return onStage(
        onStage(closing, "open", doneIfEmpty),
        "load",
        doneIfEmpty,
      );
    }
    case "close-started":
      return onLines(run, "close", event.tabIds.map(tabKey), "running");
    case "closed":
      return onLines(run, "close", event.tabIds.map(tabKey), "done");
    case "open-started":
      return onLines(run, "open", [urlKey(event.index)], "running");
    case "opened":
      return onLines(run, "open", [urlKey(event.index)], "done");
    case "load-wait-started":
      return onLines(run, "load", event.indexes.map(urlKey), "running");
    case "loaded":
      return onLines(run, "load", [urlKey(event.index)], "done");
    case "load-timed-out":
      return onLines(
        run,
        "load",
        [urlKey(event.index)],
        "failed",
        "still loading when the request was answered",
      );
  }
};

/**
 * The group's progress after `event`. A request starting clears the log;
 * a request finishing moves it to the log; an event while no request is
 * under way changes nothing; a finished line never changes again.
 */
export const advance = (progress: Progress, event: ProgressEvent): Progress => {
  if (event.kind === "request-started") {
    return { ...progress, current: newRun(event.at, event.urls), log: null };
  }
  const run = progress.current;
  if (run === null) {
    return progress;
  }
  if (event.kind !== "request-finished") {
    return { ...progress, current: step(run, event) };
  }
  const { outcome } = event;
  return {
    ...progress,
    current: null,
    log: finish(run, event.at, outcome),
    pages: outcome.ok ? run.urls.length + outcome.kept : null,
    setAt: outcome.ok ? event.at : progress.setAt,
  };
};

/** The event that starts a `set` request. */
export const requestStarted = (
  request: SetRequest,
  at: number,
): ProgressEvent => ({ kind: "request-started", at, urls: request.urls });

/** The event a plan makes: the other pages its close steps close. */
export const planned = (state: GroupState, plan: Plan): ProgressEvent => {
  const closing = plan.steps.flatMap((step) =>
    step.kind === "close" ? step.tabIds : [],
  );
  return {
    kind: "planned",
    closing: state.groups
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.kind === "other" && closing.includes(tab.id))
      .map(({ id, url, title }) => ({ id, url, title })),
  };
};

/** The event a `set` response ends its request with. */
export const requestFinished = (
  response: SetSuccess | Failure,
  at: number,
): ProgressEvent => ({
  kind: "request-finished",
  at,
  outcome: response.ok
    ? {
        ok: true,
        opened: response.opened,
        closed: response.closed,
        kept: response.kept.length,
        unchecked: response.unchecked,
        loading: response.loading,
      }
    : {
        ok: false,
        code: response.error.code,
        message: response.error.message,
      },
});
