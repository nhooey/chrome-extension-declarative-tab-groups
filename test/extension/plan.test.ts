import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { FormState } from "../../src/extension/form-check.ts";
import { plan, type Plan } from "../../src/extension/plan.ts";
import type { Group, GroupState, GroupTab } from "../../src/extension/state.ts";
import {
  LOAD_TIMEOUT_MS,
  type NewTab,
  STEP_KINDS,
  type Step,
} from "../../src/extension/steps.ts";
import {
  type Color,
  failure,
  type SetRequest,
} from "../../src/protocol/index.ts";
import { generate } from "./generate.ts";

const page = (id: number, form: FormState = "clean"): GroupTab => ({
  id,
  url: `https://example.com/${id}`,
  title: `Page ${id}`,
  kind: "other",
  form,
});

const own = (id: number, kind: "status" | "empty"): GroupTab => ({
  id,
  url: `chrome-extension://x/${kind}.html`,
  title: kind,
  kind,
});

const group = (
  tabs: readonly GroupTab[],
  fields: Partial<Group> = {},
): Group => ({
  id: 50,
  title: "Reading",
  color: "blue",
  collapsed: false,
  windowId: 7,
  tabs,
  ...fields,
});

const state = (
  groups: readonly Group[],
  fields: Partial<GroupState> = {},
): GroupState => ({ groups, windowId: 7, statusPage: false, ...fields });

const request = (
  urls: readonly string[],
  fields: { color?: Color; createWindow?: boolean } = {},
): SetRequest => ({
  protocol: 1,
  command: "set",
  group: "Reading",
  urls,
  ...fields,
});

const url = (index: number, address: string): NewTab => ({
  role: "url",
  index,
  url: address,
});

const A = "https://a.example/";
const B = "https://b.example/";

const planned = (s: GroupState, r: SetRequest): Plan => {
  const result = plan(s, r);
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
};

const steps = (s: GroupState, r: SetRequest): readonly Step[] =>
  planned(s, r).steps;

const wait = (...tabs: readonly NewTab[]): Step => ({
  kind: "wait-for-load",
  tabs,
  timeoutMs: LOAD_TIMEOUT_MS,
});

describe("plan: rule 8, two groups with the title", () => {
  it("fails with ambiguous-group", () => {
    assert.deepEqual(
      plan(
        state([group([page(1)]), group([page(2)], { id: 51 })]),
        request([A]),
      ),
      {
        ok: false,
        error: failure("ambiguous-group", '2 tab groups are titled "Reading"'),
      },
    );
  });

  it("matches the title exactly", () => {
    const p = planned(
      state([group([page(1)], { title: "reading" }), group([page(2)])]),
      request([A]),
    );
    assert.deepEqual(p.group, { kind: "existing", groupId: 50, windowId: 7 });
  });

  it("cuts a long title short in the message", () => {
    const title = "x".repeat(100);
    const result = plan(
      state([group([page(1)], { title }), group([page(2)], { title })]),
      { ...request([A]), group: title },
    );
    assert.deepEqual(result, {
      ok: false,
      error: failure(
        "ambiguous-group",
        `2 tab groups are titled "${"x".repeat(64)}…"`,
      ),
    });
  });
});

describe("plan: rule 7, a group that does not exist", () => {
  it("makes it in the last-focused window from the first URL", () => {
    assert.deepEqual(planned(state([]), request([A, B], { color: "red" })), {
      group: { kind: "new", windowId: 7 },
      steps: [
        { kind: "open-in-window", windowId: 7, tab: url(0, A) },
        {
          kind: "create-group",
          tab: url(0, A),
          title: "Reading",
          color: "red",
        },
        { kind: "open-in-group", tab: url(1, B), at: "end" },
        wait(url(0, A), url(1, B)),
      ],
      created: true,
      opened: 2,
      closed: 0,
      kept: [],
      unchecked: 0,
    });
  });

  it("makes it from the status page when that is on", () => {
    assert.deepEqual(steps(state([], { statusPage: true }), request([A])), [
      { kind: "open-in-window", windowId: 7, tab: { role: "status" } },
      { kind: "create-group", tab: { role: "status" }, title: "Reading" },
      { kind: "open-in-group", tab: url(0, A), at: "end" },
      wait(url(0, A)),
    ]);
  });

  it("makes it from the empty page when there is nothing else", () => {
    assert.deepEqual(steps(state([]), request([])), [
      { kind: "open-in-window", windowId: 7, tab: { role: "empty" } },
      { kind: "create-group", tab: { role: "empty" }, title: "Reading" },
    ]);
  });

  it("fails with no-window when no window can hold it", () => {
    assert.deepEqual(plan(state([], { windowId: null }), request([A])), {
      ok: false,
      error: failure(
        "no-window",
        'no Chrome window can hold the new group "Reading", and "createWindow" is not true',
      ),
    });
    assert.equal(
      plan(state([], { windowId: null }), request([A], { createWindow: false }))
        .ok,
      false,
    );
  });

  it("creates an unfocused window first with createWindow", () => {
    const p = planned(
      state([], { windowId: null }),
      request([A], { createWindow: true }),
    );
    assert.deepEqual(p.group, { kind: "new-window" });
    assert.deepEqual(p.steps, [
      { kind: "create-window", tab: url(0, A) },
      { kind: "create-group", tab: url(0, A), title: "Reading" },
      wait(url(0, A)),
    ]);
  });

  it("uses the existing window even with createWindow", () => {
    assert.deepEqual(
      planned(state([]), request([A], { createWindow: true })).group,
      { kind: "new", windowId: 7 },
    );
  });
});

describe("plan: rules 3 and 6, the keeper", () => {
  it("closes the last leaving tab only after the first new tab is in", () => {
    assert.deepEqual(
      steps(state([group([page(1), page(2), page(3)])]), request([A, B])),
      [
        { kind: "close", tabIds: [1, 2] },
        { kind: "open-in-group", tab: url(0, A), at: "end" },
        { kind: "close", tabIds: [3] },
        { kind: "open-in-group", tab: url(1, B), at: "end" },
        wait(url(0, A), url(1, B)),
      ],
    );
  });

  it("needs no keeper when the status page is on", () => {
    assert.deepEqual(
      steps(
        state([group([own(1, "status"), page(2)])], { statusPage: true }),
        request([A]),
      ),
      [
        { kind: "close", tabIds: [2] },
        { kind: "open-in-group", tab: url(0, A), at: "end" },
        wait(url(0, A)),
      ],
    );
  });

  it("needs no keeper when a tab is kept", () => {
    assert.deepEqual(
      steps(state([group([page(1), page(2, "unsubmitted")])]), request([A])),
      [
        { kind: "close", tabIds: [1] },
        { kind: "open-in-group", tab: url(0, A), at: "end" },
        wait(url(0, A)),
      ],
    );
  });

  it("keeps the only tab until the first new tab is in", () => {
    assert.deepEqual(steps(state([group([page(1)])]), request([A])), [
      { kind: "open-in-group", tab: url(0, A), at: "end" },
      { kind: "close", tabIds: [1] },
      wait(url(0, A)),
    ]);
  });
});

describe("plan: rule 4, unsubmitted forms", () => {
  it("keeps unsubmitted tabs in order and counts unchecked ones", () => {
    const p = planned(
      state([
        group([
          page(1, "unsubmitted"),
          page(2, "unchecked"),
          page(3, "clean"),
          page(4, "unsubmitted"),
          page(5, "unchecked"),
        ]),
      ]),
      request([A]),
    );
    assert.deepEqual(p.steps[0], { kind: "close", tabIds: [2, 3, 5] });
    assert.deepEqual(p.kept, [
      { url: "https://example.com/1", title: "Page 1" },
      { url: "https://example.com/4", title: "Page 4" },
    ]);
    assert.equal(p.unchecked, 2);
    assert.equal(p.closed, 3);
  });
});

describe("plan: rules 1, 2 and 5, the status page and the empty page", () => {
  it("opens the status page first when the group has none", () => {
    assert.deepEqual(
      steps(state([group([page(1)])], { statusPage: true }), request([A])),
      [
        { kind: "open-in-group", tab: { role: "status" }, at: "start" },
        { kind: "close", tabIds: [1] },
        { kind: "open-in-group", tab: url(0, A), at: "end" },
        wait(url(0, A)),
      ],
    );
  });

  it("moves the status page first and closes a duplicate", () => {
    assert.deepEqual(
      steps(
        state(
          [group([page(1, "unsubmitted"), own(2, "status"), own(3, "status")])],
          {
            statusPage: true,
          },
        ),
        request([]),
      ),
      [
        { kind: "move-first", tabId: 2 },
        { kind: "close", tabIds: [3] },
      ],
    );
  });

  it("closes the status page when it is off", () => {
    assert.deepEqual(
      steps(state([group([own(1, "status"), page(2)])]), request([A])),
      [
        { kind: "close", tabIds: [1] },
        { kind: "open-in-group", tab: url(0, A), at: "end" },
        { kind: "close", tabIds: [2] },
        wait(url(0, A)),
      ],
    );
  });

  it("leaves only the status page for an empty list when it is on", () => {
    const p = planned(
      state([group([own(1, "status"), own(2, "empty"), page(3)])], {
        statusPage: true,
      }),
      request([]),
    );
    assert.deepEqual(p.steps, [{ kind: "close", tabIds: [2, 3] }]);
    assert.equal(p.closed, 1);
    assert.equal(p.opened, 0);
  });

  it("opens the empty page for an empty list when it is off", () => {
    const p = planned(state([group([own(1, "status"), page(2)])]), request([]));
    assert.deepEqual(p.steps, [
      { kind: "close", tabIds: [1] },
      { kind: "open-in-group", tab: { role: "empty" }, at: "end" },
      { kind: "close", tabIds: [2] },
    ]);
    assert.equal(p.closed, 1);
    assert.equal(p.opened, 0);
  });

  it("leaves the empty page alone when it is to stay", () => {
    assert.deepEqual(
      steps(
        state([group([page(1), own(2, "empty"), own(3, "empty")])]),
        request([]),
      ),
      [{ kind: "close", tabIds: [1, 3] }],
    );
    assert.deepEqual(steps(state([group([own(1, "empty")])]), request([])), []);
  });

  it("closes the empty page when the group will hold anything else", () => {
    assert.deepEqual(steps(state([group([own(1, "empty")])]), request([A])), [
      { kind: "open-in-group", tab: url(0, A), at: "end" },
      { kind: "close", tabIds: [1] },
      wait(url(0, A)),
    ]);
  });

  it("reopens a URL that a tab already shows", () => {
    assert.deepEqual(
      steps(state([group([page(1)])]), request(["https://example.com/1"])),
      [
        {
          kind: "open-in-group",
          tab: url(0, "https://example.com/1"),
          at: "end",
        },
        { kind: "close", tabIds: [1] },
        wait(url(0, "https://example.com/1")),
      ],
    );
  });
});

describe("plan: rule 9, colour and collapse", () => {
  it("changes the colour only when the request gives a different one", () => {
    const s = state([group([own(1, "empty")], { color: "blue" })]);
    assert.deepEqual(steps(s, request([], { color: "green" })), [
      { kind: "set-color", color: "green" },
    ]);
    assert.deepEqual(steps(s, request([], { color: "blue" })), []);
    assert.deepEqual(steps(s, request([])), []);
  });

  it("collapses a collapsed group last before waiting", () => {
    assert.deepEqual(
      steps(state([group([page(1)], { collapsed: true })]), request([A])),
      [
        { kind: "open-in-group", tab: url(0, A), at: "end" },
        { kind: "close", tabIds: [1] },
        { kind: "collapse" },
        wait(url(0, A)),
      ],
    );
  });
});

describe("plan: rule 10, nothing can focus", () => {
  // Fails to type-check when a kind is added to Step but not STEP_KINDS.
  type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
  const listed: Same<Step["kind"], (typeof STEP_KINDS)[number]> = true;

  it("has exactly these step kinds, none of which focuses", () => {
    assert.ok(listed);
    assert.deepEqual(STEP_KINDS, [
      "create-window",
      "open-in-window",
      "create-group",
      "open-in-group",
      "move-first",
      "close",
      "set-color",
      "collapse",
      "wait-for-load",
    ]);
  });

  // Each kind's fields, and a new tab's. The types below fail to check when
  // a field such as `active` is added to Step or NewTab but not listed here,
  // and the test fails when a plan carries a field that is not listed.
  const fields = {
    "create-window": ["kind", "tab"],
    "open-in-window": ["kind", "tab", "windowId"],
    "create-group": ["color", "kind", "tab", "title"],
    "open-in-group": ["at", "kind", "tab"],
    "move-first": ["kind", "tabId"],
    close: ["kind", "tabIds"],
    "set-color": ["color", "kind"],
    collapse: ["kind"],
    "wait-for-load": ["kind", "tabs", "timeoutMs"],
  } as const satisfies { readonly [K in Step["kind"]]: readonly string[] };
  const tabFields = ["index", "role", "url"] as const;
  type KeysOf<T> = T extends unknown ? keyof T : never;
  type FieldsListed = {
    readonly [K in Step["kind"]]: Same<
      keyof Extract<Step, { kind: K }>,
      (typeof fields)[K][number]
    >;
  }[Step["kind"]];
  const fieldsListed: Same<FieldsListed, true> = true;
  const tabFieldsListed: Same<
    KeysOf<NewTab>,
    (typeof tabFields)[number]
  > = true;

  it("gives each step only these fields", () => {
    assert.ok(fieldsListed && tabFieldsListed);
    const fieldsOf: { readonly [K in Step["kind"]]: readonly string[] } =
      fields;
    const tabFieldsOf: readonly string[] = tabFields;
    const generated = [true, false].flatMap((statusPage) =>
      Array.from({ length: 500 }, (_, seed) => generate(seed, statusPage)),
    );
    for (const c of generated) {
      const result = plan(c.state, c.request);
      for (const step of result.ok ? result.value.steps : []) {
        for (const key of Object.keys(step)) {
          assert.ok(fieldsOf[step.kind].includes(key), `${step.kind}.${key}`);
        }
        const tabs =
          "tab" in step ? [step.tab] : "tabs" in step ? step.tabs : [];
        for (const key of tabs.flatMap((tab) => Object.keys(tab))) {
          assert.ok(tabFieldsOf.includes(key), `${step.kind} tab ${key}`);
        }
      }
    }
  });
});
