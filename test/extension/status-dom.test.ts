// The status page's tree-to-DOM function against a minimal fake document:
// labels land as text, and a redraw keeps the element of each line it
// already shows.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  advance,
  idle,
  type ProgressEvent,
} from "../../src/extension/progress.ts";
import {
  drawStatus,
  type StatusDocument,
  type StatusElement,
} from "../../src/extension/status-dom.ts";
import { view } from "../../src/extension/view.ts";

type FakeElement = StatusElement & {
  readonly tag: string;
  readonly kids: FakeElement[];
  parent: FakeElement | null;
};

/** An element holding either text or child elements, as textContent leaves it. */
const element = (tag: string): FakeElement => {
  const attributes = new Map<string, string>();
  const kids: FakeElement[] = [];
  let text = "";
  const self: FakeElement = {
    tag,
    kids,
    parent: null,
    get textContent() {
      return kids.length > 0
        ? kids.map((kid) => kid.textContent ?? "").join("")
        : text;
    },
    set textContent(value: string | null) {
      kids.splice(0).forEach((kid) => {
        kid.parent = null;
      });
      text = value ?? "";
    },
    get children() {
      return kids;
    },
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => {
      attributes.set(name, value);
    },
    removeAttribute: (name) => {
      attributes.delete(name);
    },
    appendChild: (node) => self.insertBefore(node, null),
    insertBefore: (node, child) => {
      const moving = node as FakeElement;
      moving.remove();
      const at = child === null ? -1 : kids.indexOf(child as FakeElement);
      kids.splice(at === -1 ? kids.length : at, 0, moving);
      moving.parent = self;
      return node;
    },
    remove: () => {
      const siblings = self.parent?.kids;
      siblings?.splice(siblings.indexOf(self), 1);
      self.parent = null;
    },
  };
  return self;
};

const fakeDocument = () => {
  const created: string[] = [];
  const heading = element("h1");
  const list = element("ul");
  const doc: StatusDocument = {
    title: "",
    createElement: (tag) => {
      created.push(tag);
      return element(tag);
    },
    getElementById: (id) =>
      id === "group" ? heading : id === "status" ? list : null,
  };
  return { doc, heading, list, created };
};

const byKey = (parent: FakeElement, key: string): FakeElement => {
  const found = parent.kids.find((kid) => kid.getAttribute("data-key") === key);
  assert.ok(found !== undefined, key);
  return found;
};

/** A line's own list of child lines, its last part. */
const linesOf = (item: FakeElement): FakeElement => {
  const list = item.kids.at(-1);
  assert.ok(list !== undefined && list.tag === "ul");
  return list;
};

const labelOf = (item: FakeElement): string | null =>
  item.kids.find((kid) => kid.getAttribute("class") === "label")?.textContent ??
  null;

const formatTime = (time: number): string => `at ${time}`;

const SCRIPT = '<script>alert("x")</script><b>bold</b>';

const PART_WAY: readonly ProgressEvent[] = [
  { kind: "request-started", at: 1_000, urls: ["https://a.example/"] },
  {
    kind: "check-started",
    tabs: [{ id: 2, url: "https://example.com/2", title: SCRIPT }],
  },
  { kind: "tab-checked", tabId: 2, form: "clean" },
  {
    kind: "planned",
    closing: [{ id: 2, url: "https://example.com/2", title: SCRIPT }],
  },
  { kind: "close-started", tabIds: [2] },
];

const progressAfter = (events: readonly ProgressEvent[], group = "Reading") =>
  events.reduce(advance, idle(group));

describe("drawStatus", () => {
  it("draws the title, the heading and the idle line", () => {
    const { doc, heading, list } = fakeDocument();
    drawStatus(doc, view(idle("Reading")), formatTime);
    assert.equal(doc.title, "Reading");
    assert.equal(heading.textContent, "Reading");
    assert.deepEqual(
      list.kids.map((kid) => kid.getAttribute("data-key")),
      ["now"],
    );
    const [now] = list.kids;
    assert.equal(
      labelOf(now!),
      "Reading has not been set since Chrome started",
    );
    assert.equal(now?.getAttribute("data-state"), null);
  });

  it("puts a title holding markup on the page as text", () => {
    const { doc, heading, list, created } = fakeDocument();
    drawStatus(doc, view(progressAfter(PART_WAY, SCRIPT)), formatTime);
    assert.equal(heading.textContent, SCRIPT);
    const check = byKey(linesOf(byKey(list, "now")), "check");
    assert.equal(labelOf(byKey(linesOf(check), "tab 2")), SCRIPT);
    assert.deepEqual(
      [...new Set(created)].toSorted(),
      ["li", "span", "time", "ul"],
      "no element but the line's own parts is made",
    );
  });

  it("writes each line's state and time", () => {
    const { doc, list } = fakeDocument();
    drawStatus(doc, view(progressAfter(PART_WAY)), formatTime);
    const now = byKey(list, "now");
    assert.equal(now.getAttribute("data-state"), "running");
    const time = now.kids.find((kid) => kid.tag === "time");
    assert.equal(time?.getAttribute("datetime"), new Date(1_000).toISOString());
    assert.equal(time?.textContent, "at 1000");
    const state = now.kids.find((kid) => kid.getAttribute("class") === "state");
    assert.equal(state?.textContent, "Under way:");
    const close = byKey(linesOf(now), "close");
    assert.equal(
      byKey(linesOf(close), "tab 2").getAttribute("data-state"),
      "running",
    );
  });

  it("keeps a line's element as its state changes, and drops lines no longer shown", () => {
    const { doc, list } = fakeDocument();
    drawStatus(doc, view(progressAfter(PART_WAY)), formatTime);
    const now = byKey(list, "now");
    const closing = byKey(linesOf(byKey(linesOf(now), "close")), "tab 2");
    drawStatus(
      doc,
      view(progressAfter([...PART_WAY, { kind: "closed", tabIds: [2] }])),
      formatTime,
    );
    assert.equal(byKey(list, "now"), now);
    assert.equal(
      byKey(linesOf(byKey(linesOf(now), "close")), "tab 2"),
      closing,
    );
    assert.equal(closing.getAttribute("data-state"), "done");
    drawStatus(
      doc,
      view(
        progressAfter([
          ...PART_WAY,
          {
            kind: "request-finished",
            at: 2_000,
            outcome: { ok: false, code: "busy", message: "busy" },
          },
        ]),
      ),
      formatTime,
    );
    assert.deepEqual(
      list.kids.map((kid) => kid.getAttribute("data-key")),
      ["now", "log"],
    );
    assert.deepEqual(linesOf(byKey(list, "now")).kids, []);
    assert.equal(byKey(list, "now").getAttribute("data-state"), null);
  });
});
