// `advance`: each event on fixed states, and the rules every fold keeps.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  advance,
  idle,
  isFinished,
  type LineState,
  type Progress,
  type ProgressEvent,
  type Run,
  type StageKind,
} from "../../src/extension/progress.ts";

const A = "https://a.example/";
const B = "https://b.example/";

const tab2 = { id: 2, url: "https://example.com/2", title: "Page 2" };
const tab3 = { id: 3, url: "https://example.com/3", title: "" };

const fold = (events: readonly ProgressEvent[], from = idle("Reading")) =>
  events.reduce(advance, from);

const started: ProgressEvent = {
  kind: "request-started",
  at: 10,
  urls: [A, B],
};

/** A request on a group of two tabs, carried up to its last load. */
const UNDER_WAY: readonly ProgressEvent[] = [
  started,
  { kind: "check-started", tabs: [tab2, tab3] },
  { kind: "tab-checked", tabId: 2, form: "clean" },
  { kind: "tab-checked", tabId: 3, form: "unchecked" },
  { kind: "planned", closing: [tab2, tab3] },
  { kind: "close-started", tabIds: [2, 3] },
  { kind: "closed", tabIds: [2, 3] },
  { kind: "open-started", index: 0 },
  { kind: "opened", index: 0 },
  { kind: "open-started", index: 1 },
  { kind: "opened", index: 1 },
  { kind: "load-wait-started", indexes: [0, 1] },
  { kind: "loaded", index: 1 },
];

const success: ProgressEvent = {
  kind: "request-finished",
  at: 90,
  outcome: {
    ok: true,
    opened: 2,
    closed: 2,
    kept: 0,
    unchecked: 1,
    loading: 0,
  },
};

const current = (progress: Progress): Run => {
  assert.ok(progress.current !== null);
  return progress.current;
};

/** Each stage's state and its lines' states, as one compact record. */
const states = (
  run: Run,
): { readonly [K in StageKind]?: readonly LineState[] } =>
  Object.fromEntries(
    run.stages.map((stage) => [
      stage.kind,
      [stage.state, ...stage.lines.map((line) => line.state)],
    ]),
  );

describe("advance: a request starting", () => {
  it("starts a checklist with a waiting line per URL to open and load", () => {
    const progress = fold([started]);
    assert.deepEqual(current(progress), {
      urls: [A, B],
      startedAt: 10,
      stages: [
        { kind: "check", state: "waiting", lines: [] },
        { kind: "close", state: "waiting", lines: [] },
        {
          kind: "open",
          state: "waiting",
          lines: [
            { key: "url 0", label: A, state: "waiting" },
            { key: "url 1", label: B, state: "waiting" },
          ],
        },
        {
          kind: "load",
          state: "waiting",
          lines: [
            { key: "url 0", label: A, state: "waiting" },
            { key: "url 1", label: B, state: "waiting" },
          ],
        },
      ],
      finishedAt: null,
      outcome: null,
    });
  });

  it("clears the log of the request before", () => {
    const finished = fold([...UNDER_WAY, success]);
    assert.notEqual(finished.log, null);
    const next = advance(finished, { ...started, at: 100 });
    assert.equal(next.log, null);
    assert.equal(current(next).startedAt, 100);
    assert.equal(next.pages, 2, "the idle facts stay until it finishes");
  });
});

describe("advance: each event", () => {
  it("runs the form check on every tab at once, then records each result", () => {
    const checking = fold([
      started,
      { kind: "check-started", tabs: [tab2, tab3] },
    ]);
    assert.deepEqual(current(checking).stages[0], {
      kind: "check",
      state: "running",
      lines: [
        { key: "tab 2", label: "Page 2", state: "running" },
        { key: "tab 3", label: "https://example.com/3", state: "running" },
      ],
    });
    const kept = advance(checking, {
      kind: "tab-checked",
      tabId: 2,
      form: "unsubmitted",
    });
    assert.deepEqual(states(current(kept)).check, [
      "running",
      "kept",
      "running",
    ]);
    const both = advance(kept, {
      kind: "tab-checked",
      tabId: 3,
      form: "unchecked",
    });
    assert.deepEqual(states(current(both)).check, [
      "done",
      "kept",
      "unchecked",
    ]);
  });

  it("finishes a check of no tab at once", () => {
    const progress = fold([started, { kind: "check-started", tabs: [] }]);
    assert.deepEqual(states(current(progress)).check, ["done"]);
  });

  it("lists the tabs to close once planned, and finishes stages with nothing to do", () => {
    const progress = fold([
      { kind: "request-started", at: 0, urls: [] },
      { kind: "check-started", tabs: [tab2] },
      { kind: "tab-checked", tabId: 2, form: "clean" },
      { kind: "planned", closing: [tab2] },
    ]);
    assert.deepEqual(states(current(progress)), {
      check: ["done", "done"],
      close: ["waiting", "waiting"],
      open: ["done"],
      load: ["done"],
    });
  });

  it("marks closes, opens and loads as they start and end", () => {
    const steps = UNDER_WAY.map((_, index) =>
      states(current(fold(UNDER_WAY.slice(0, index + 1)))),
    );
    assert.deepEqual(steps.at(5)?.close, ["running", "running", "running"]);
    assert.deepEqual(steps.at(6)?.close, ["done", "done", "done"]);
    assert.deepEqual(steps.at(7)?.open, ["running", "running", "waiting"]);
    assert.deepEqual(steps.at(8)?.open, ["running", "done", "waiting"]);
    assert.deepEqual(steps.at(10)?.open, ["done", "done", "done"]);
    assert.deepEqual(steps.at(11)?.load, ["running", "running", "running"]);
    assert.deepEqual(steps.at(12)?.load, ["running", "running", "done"]);
  });

  it("fails a load that times out, saying it was still loading", () => {
    const progress = fold([...UNDER_WAY, { kind: "load-timed-out", index: 0 }]);
    const load = current(progress).stages[3];
    assert.equal(load?.state, "failed");
    assert.deepEqual(load?.lines[0], {
      key: "url 0",
      label: A,
      state: "failed",
      note: "still loading when the request was answered",
    });
  });

  it("ignores an event while no request is under way", () => {
    const quiet = idle("Reading");
    assert.equal(advance(quiet, { kind: "opened", index: 0 }), quiet);
    assert.equal(advance(quiet, success), quiet);
  });
});

describe("advance: a request finishing", () => {
  it("moves the finished checklist to the log, every line done", () => {
    const progress = fold([
      ...UNDER_WAY,
      { kind: "loaded", index: 0 },
      success,
    ]);
    assert.equal(progress.current, null);
    assert.ok(progress.log !== null);
    assert.deepEqual(states(progress.log), {
      check: ["done", "done", "unchecked"],
      close: ["done", "done", "done"],
      open: ["done", "done", "done"],
      load: ["done", "done", "done"],
    });
    assert.equal(progress.log.finishedAt, 90);
    assert.deepEqual(progress.log.outcome, {
      ok: true,
      opened: 2,
      closed: 2,
      kept: 0,
      unchecked: 1,
      loading: 0,
    });
    assert.equal(progress.pages, 2);
    assert.equal(progress.setAt, 90);
  });

  it("counts the kept tabs among the group's pages", () => {
    const progress = fold([
      started,
      {
        kind: "request-finished",
        at: 20,
        outcome: {
          ok: true,
          opened: 2,
          closed: 0,
          kept: 1,
          unchecked: 0,
          loading: 0,
        },
      },
    ]);
    assert.equal(progress.pages, 3);
  });

  it("ends a failed request in the log with its error, failing what ran", () => {
    const before = fold([...UNDER_WAY, success]);
    const progress = fold(
      [
        { ...started, at: 200 },
        { kind: "check-started", tabs: [] },
        { kind: "planned", closing: [tab2] },
        { kind: "close-started", tabIds: [2] },
        {
          kind: "request-finished",
          at: 205,
          outcome: { ok: false, code: "busy", message: "Chrome refused" },
        },
      ],
      before,
    );
    assert.equal(progress.current, null);
    assert.ok(progress.log !== null);
    assert.deepEqual(progress.log.outcome, {
      ok: false,
      code: "busy",
      message: "Chrome refused",
    });
    assert.deepEqual(states(progress.log), {
      check: ["done"],
      close: ["failed", "failed"],
      open: ["waiting", "waiting", "waiting"],
      load: ["waiting", "waiting", "waiting"],
    });
    assert.equal(progress.pages, null, "the group's pages are not known");
    assert.equal(progress.setAt, 90, "it was last set by the request before");
  });
});

describe("advance: a finished line", () => {
  it("never goes back to running, whatever comes after", () => {
    const events: readonly ProgressEvent[] = [
      ...UNDER_WAY,
      { kind: "close-started", tabIds: [2, 3] },
      { kind: "open-started", index: 0 },
      { kind: "load-wait-started", indexes: [0, 1] },
      { kind: "check-started", tabs: [tab2] },
      { kind: "tab-checked", tabId: 2, form: "unsubmitted" },
      { kind: "load-timed-out", index: 1 },
    ];
    const seen = new Map<string, LineState>();
    events.reduce((progress, event) => {
      const next = advance(progress, event);
      for (const stage of current(next).stages) {
        for (const line of stage.lines) {
          const key = `${stage.kind} ${line.key}`;
          const before = seen.get(key);
          if (before !== undefined && isFinished(before)) {
            assert.equal(line.state, before, `${key} after ${event.kind}`);
          }
          seen.set(key, line.state);
        }
      }
      return next;
    }, idle("Reading"));
  });
});
