// `view`: the status page's tree for an idle group, an empty one, a request
// part-way and a finished one.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  advance,
  idle,
  type Progress,
  type ProgressEvent,
} from "../../src/extension/progress.ts";
import { view, type ViewNode } from "../../src/extension/view.ts";

const A = "https://a.example/";

const fold = (events: readonly ProgressEvent[]): Progress =>
  events.reduce(advance, idle("Reading"));

const PART_WAY: readonly ProgressEvent[] = [
  { kind: "request-started", at: 1_000, urls: [A] },
  {
    kind: "check-started",
    tabs: [
      { id: 2, url: "https://example.com/2", title: "Page 2" },
      { id: 3, url: "https://example.com/3", title: "Draft" },
    ],
  },
  { kind: "tab-checked", tabId: 2, form: "clean" },
  { kind: "tab-checked", tabId: 3, form: "unsubmitted" },
  {
    kind: "planned",
    closing: [{ id: 2, url: "https://example.com/2", title: "Page 2" }],
  },
  { kind: "close-started", tabIds: [2] },
];

const FINISHED: readonly ProgressEvent[] = [
  ...PART_WAY,
  { kind: "closed", tabIds: [2] },
  { kind: "open-started", index: 0 },
  { kind: "opened", index: 0 },
  { kind: "load-wait-started", indexes: [0] },
  { kind: "loaded", index: 0 },
  {
    kind: "request-finished",
    at: 4_000,
    outcome: {
      ok: true,
      opened: 1,
      closed: 1,
      kept: 1,
      unchecked: 0,
      loading: 0,
    },
  },
];

/** A node and its descendants as label and state, without keys. */
const outline = (node: ViewNode): unknown => [
  node.label,
  node.state,
  ...(node.children.length === 0 ? [] : [node.children.map(outline)]),
];

describe("view", () => {
  it("shows a group no request has set since Chrome started", () => {
    assert.deepEqual(view(idle("Reading")), {
      title: "Reading",
      heading: "Reading",
      sections: [
        {
          key: "now",
          label: "Reading has not been set since Chrome started",
          state: null,
          children: [],
        },
      ],
    });
  });

  it("shows an empty group and when it was last set", () => {
    const progress = fold([
      { kind: "request-started", at: 5, urls: [] },
      {
        kind: "request-finished",
        at: 7,
        outcome: {
          ok: true,
          opened: 0,
          closed: 2,
          kept: 0,
          unchecked: 0,
          loading: 0,
        },
      },
    ]);
    const shown = view(progress);
    assert.equal(shown.title, "Reading: empty");
    assert.deepEqual(shown.sections[0], {
      key: "now",
      label: "Reading is empty",
      state: null,
      children: [
        {
          key: "set-at",
          label: "Last set",
          state: null,
          time: 7,
          children: [],
        },
      ],
    });
  });

  it("shows a request part-way as a live checklist", () => {
    const shown = view(fold(PART_WAY));
    assert.equal(shown.title, "Reading: setting");
    assert.equal(
      shown.sections.length,
      1,
      "no log while the next request runs",
    );
    const [now] = shown.sections;
    assert.ok(now !== undefined);
    assert.equal(now.time, 1_000);
    assert.deepEqual(outline(now), [
      "Set the group to 1 page",
      "running",
      [
        [
          "Check the tabs for unsubmitted forms",
          "done",
          [
            ["Page 2", "done"],
            ["Draft", "kept"],
          ],
        ],
        ["Close the tabs that go", "running", [["Page 2", "running"]]],
        ["Open each page", "waiting", [[A, "waiting"]]],
        ["Wait for the pages to load", "waiting", [[A, "waiting"]]],
      ],
    ]);
  });

  it("shows a finished request in the log under the idle state", () => {
    const shown = view(fold(FINISHED));
    assert.equal(shown.title, "Reading: 2 pages");
    const [now, log] = shown.sections;
    assert.deepEqual(outline(now!), [
      "Reading holds 2 pages",
      null,
      [["Last set", null]],
    ]);
    assert.equal(log?.time, 4_000);
    assert.deepEqual(outline(log!), [
      "Latest request: set the group to 1 page",
      "done",
      [
        [
          "Check the tabs for unsubmitted forms",
          "done",
          [
            ["Page 2", "done"],
            ["Draft", "kept"],
          ],
        ],
        ["Close the tabs that go", "done", [["Page 2", "done"]]],
        ["Open each page", "done", [[A, "done"]]],
        ["Wait for the pages to load", "done", [[A, "done"]]],
        [
          "Opened 1 page, closed 1 tab, kept 1 tab with an unsubmitted form",
          "done",
        ],
      ],
    ]);
  });

  it("names a stage with nothing to do, and a failure with its error", () => {
    const shown = view(
      fold([
        { kind: "request-started", at: 0, urls: [] },
        { kind: "check-started", tabs: [] },
        {
          kind: "request-finished",
          at: 1,
          outcome: {
            ok: false,
            code: "ambiguous-group",
            message: '2 tab groups are titled "Reading"',
          },
        },
      ]),
    );
    assert.equal(shown.title, "Reading: failed");
    const [now, log] = shown.sections;
    assert.equal(
      now?.label,
      "Reading: its pages are not known, since its last request failed",
    );
    assert.deepEqual(outline(log!), [
      "Latest request: empty the group",
      "failed",
      [
        ["Check the tabs for unsubmitted forms: no tab to check", "done"],
        ["Close the tabs that go", "waiting"],
        ["Open each page", "waiting"],
        ["Wait for the pages to load", "waiting"],
        [
          'Failed (ambiguous-group): 2 tab groups are titled "Reading"',
          "failed",
        ],
      ],
    ]);
  });
});
