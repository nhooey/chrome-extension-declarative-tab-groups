// What the status page shows, as nested plain data: the request under way
// as a checklist, or the idle state, and the latest finished request as
// the log. Pure: the page's edge turns the tree into DOM nodes.

import {
  type LineState,
  type Outcome,
  type Progress,
  type Run,
  type Stage,
  type StageKind,
} from "./progress.ts";

/** One line of the page: a label, its state if it has one, and its children. */
export type ViewNode = {
  /** Unique among its siblings, so a redraw keeps a line's element. */
  readonly key: string;
  readonly label: string;
  readonly state: LineState | null;
  /** A time the line names, in milliseconds since the epoch. */
  readonly time?: number;
  readonly children: readonly ViewNode[];
};

export type StatusView = {
  /** The tab's title. */
  readonly title: string;
  /** The group's title, as the page's heading. */
  readonly heading: string;
  /** The current state first, then the log when there is one. */
  readonly sections: readonly ViewNode[];
};

const STAGE_LABELS: { readonly [K in StageKind]: string } = {
  check: "Check the tabs for unsubmitted forms",
  close: "Close the tabs that go",
  open: "Open each page",
  load: "Wait for the pages to load",
};

const NOTHING: { readonly [K in StageKind]: string } = {
  check: "no tab to check",
  close: "no tab to close",
  open: "no page to open",
  load: "no page to wait for",
};

export const count = (n: number, noun: string): string =>
  `${n} ${noun}${n === 1 ? "" : "s"}`;

const leaf = (
  key: string,
  label: string,
  state: LineState | null,
  time?: number,
): ViewNode => ({
  key,
  label,
  state,
  ...(time === undefined ? {} : { time }),
  children: [],
});

const stageNode = (stage: Stage): ViewNode => ({
  key: stage.kind,
  label:
    stage.lines.length === 0 && stage.state === "done"
      ? `${STAGE_LABELS[stage.kind]}: ${NOTHING[stage.kind]}`
      : STAGE_LABELS[stage.kind],
  state: stage.state,
  children: stage.lines.map((line) =>
    leaf(
      line.key,
      line.note === undefined ? line.label : `${line.label} (${line.note})`,
      line.state,
    ),
  ),
});

const requestLabel = (run: Run): string =>
  run.urls.length === 0
    ? "Empty the group"
    : `Set the group to ${count(run.urls.length, "page")}`;

const summary = (outcome: Outcome): ViewNode =>
  outcome.ok
    ? leaf(
        "outcome",
        [
          `Opened ${count(outcome.opened, "page")}`,
          `closed ${count(outcome.closed, "tab")}`,
          ...(outcome.kept > 0
            ? [`kept ${count(outcome.kept, "tab")} with an unsubmitted form`]
            : []),
          ...(outcome.unchecked > 0
            ? [`${outcome.unchecked} closed without the form check`]
            : []),
          ...(outcome.loading > 0 ? [`${outcome.loading} still loading`] : []),
        ].join(", "),
        "done",
      )
    : leaf("outcome", `Failed (${outcome.code}): ${outcome.message}`, "failed");

const pagesLabel = ({ group, pages, log }: Progress): string =>
  pages === null
    ? log?.outcome?.ok === false
      ? `${group}: its pages are not known, since its last request failed`
      : `${group} has not been set since Chrome started`
    : pages === 0
      ? `${group} is empty`
      : `${group} holds ${count(pages, "page")}`;

const currentNode = (progress: Progress): ViewNode => {
  const run = progress.current;
  return run === null
    ? {
        key: "now",
        label: pagesLabel(progress),
        state: null,
        children:
          progress.setAt === null
            ? []
            : [leaf("set-at", "Last set", null, progress.setAt)],
      }
    : {
        key: "now",
        label: requestLabel(run),
        state: "running",
        time: run.startedAt,
        children: run.stages.map(stageNode),
      };
};

const logNode = (run: Run): ViewNode => ({
  key: "log",
  label: `Latest request: ${requestLabel(run).toLowerCase()}`,
  state: run.outcome?.ok === false ? "failed" : "done",
  ...(run.finishedAt === null ? {} : { time: run.finishedAt }),
  children: [
    ...run.stages.map(stageNode),
    ...(run.outcome === null ? [] : [summary(run.outcome)]),
  ],
});

const titleOf = (progress: Progress): string =>
  progress.current !== null
    ? `${progress.group}: setting`
    : progress.log?.outcome?.ok === false
      ? `${progress.group}: failed`
      : progress.pages === null
        ? progress.group
        : progress.pages === 0
          ? `${progress.group}: empty`
          : `${progress.group}: ${count(progress.pages, "page")}`;

/** The status page's content for the group's progress. */
export const view = (progress: Progress): StatusView => ({
  title: titleOf(progress),
  heading: progress.group,
  sections: [
    currentNode(progress),
    ...(progress.log === null ? [] : [logNode(progress.log)]),
  ],
});
