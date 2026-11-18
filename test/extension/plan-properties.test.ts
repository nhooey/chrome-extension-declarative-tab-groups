import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { plan, type Plan } from "../../src/extension/plan.ts";
import type { Group, GroupTab } from "../../src/extension/state.ts";
import {
  LOAD_TIMEOUT_MS,
  type NewTab,
  STEP_KINDS,
} from "../../src/extension/steps.ts";
import { type Case, generate, TITLE } from "./generate.ts";
import { existingKey, newKey, type ModelTab, simulate } from "./simulate.ts";

/** A URL tab as its model key and URL, so a test compares both. */
const urlTab = (
  tab: NewTab,
): readonly { readonly key: string; readonly url: string }[] =>
  tab.role === "url" ? [{ key: newKey(tab), url: tab.url }] : [];

const CASES = 1500;

const cases: readonly Case[] = [true, false].flatMap((statusPage) =>
  Array.from({ length: CASES }, (_, seed) => generate(seed, statusPage)),
);

const matchingGroups = (c: Case): readonly Group[] =>
  c.state.groups.filter((group) => group.title === TITLE);

/** The group's contents after the plan, as rule 5 states them. */
const expectedKeys = (c: Case): readonly string[] => {
  const group = matchingGroups(c)[0];
  const tabs: readonly GroupTab[] = group?.tabs ?? [];
  const status = tabs.find((tab) => tab.kind === "status");
  const empty = tabs.find((tab) => tab.kind === "empty");
  const kept = tabs.filter(
    (tab) => tab.kind === "other" && tab.form === "unsubmitted",
  );
  const contents = [
    ...(c.state.statusPage
      ? [status === undefined ? "new status" : existingKey(status.id)]
      : []),
    ...kept.map((tab) => existingKey(tab.id)),
    ...c.request.urls.map((_, index) => `new url ${index}`),
  ];
  return contents.length > 0
    ? contents
    : [empty === undefined ? "new empty" : existingKey(empty.id)];
};

/** The plans of the cases that do not fail, with their simulations. */
const planned = cases.flatMap((c) => {
  const result = plan(c.state, c.request);
  return result.ok
    ? [
        {
          c,
          plan: result.value,
          run: simulate(c.state, c.request, result.value.steps),
        },
      ]
    : [];
});

const label = (c: Case): string =>
  `seed ${c.seed}, status page ${c.state.statusPage ? "on" : "off"}`;

describe("plan over generated states", () => {
  it("covers every outcome and step kind", () => {
    const outcomes = new Set(
      cases.map((c) => {
        const result = plan(c.state, c.request);
        return result.ok ? result.value.group.kind : result.error.error.code;
      }),
    );
    assert.deepEqual([...outcomes].sort(), [
      "ambiguous-group",
      "existing",
      "new",
      "new-window",
      "no-window",
    ]);
    const kinds = new Set(
      planned.flatMap(({ plan }) => plan.steps.map((step) => step.kind)),
    );
    assert.deepEqual([...kinds].sort(), [...STEP_KINDS].sort());
  });

  it("fails exactly when rules 7 and 8 say so", () => {
    for (const c of cases) {
      const result = plan(c.state, c.request);
      const matching = matchingGroups(c).length;
      const code = result.ok ? null : result.error.error.code;
      const expected =
        matching > 1
          ? "ambiguous-group"
          : matching === 0 &&
              c.state.windowId === null &&
              c.request.createWindow !== true
            ? "no-window"
            : null;
      assert.equal(code, expected, label(c));
    }
  });

  it("never leaves an existing group with no tab", () => {
    for (const { c, run } of planned) {
      run.after.forEach((model, index) =>
        assert.ok(
          !model.exists || model.tabs.length > 0,
          `${label(c)}: no tab after step ${index}`,
        ),
      );
    }
  });

  it("never closes a tab with an unsubmitted form", () => {
    for (const { c, run } of planned) {
      assert.deepEqual(
        run.closed.filter((tab) => tab.form === "unsubmitted"),
        [],
        label(c),
      );
    }
  });

  it("ends with the contents rule 5 states", () => {
    for (const { c, run } of planned) {
      assert.deepEqual(
        run.final.tabs.map((tab) => tab.key),
        expectedKeys(c),
        label(c),
      );
    }
  });

  it("keeps the status page while on, and closes every one while off", () => {
    for (const { c, run } of planned) {
      const statusTabs = (matchingGroups(c)[0]?.tabs ?? []).filter(
        (tab) => tab.kind === "status",
      );
      const closedStatus = run.closed
        .filter((tab: ModelTab) => tab.kind === "status")
        .map((tab) => tab.key);
      const first = statusTabs[0];
      if (c.state.statusPage) {
        assert.ok(
          first === undefined || !closedStatus.includes(existingKey(first.id)),
          label(c),
        );
        assert.equal(
          run.final.tabs.filter((tab) => tab.kind === "status").length,
          1,
          label(c),
        );
      } else {
        assert.deepEqual(
          closedStatus,
          statusTabs.map((tab) => existingKey(tab.id)),
          label(c),
        );
        assert.ok(!run.opened.some((tab) => tab.role === "status"), label(c));
      }
    }
  });

  it("closes every page of the extension's naming another group", () => {
    const withStray = planned.filter(({ c }) =>
      (matchingGroups(c)[0]?.tabs ?? []).some((tab) => tab.kind === "stray"),
    );
    assert.ok(withStray.length > 100, `${withStray.length} cases`);
    for (const { c, run } of withStray) {
      const strays = (matchingGroups(c)[0]?.tabs ?? [])
        .filter((tab) => tab.kind === "stray")
        .map((tab) => existingKey(tab.id));
      assert.deepEqual(
        run.closed.map((tab) => tab.key).filter((key) => strays.includes(key)),
        strays,
        label(c),
      );
    }
  });

  it("activates the status page exactly when the window's active tab closes, before any close", () => {
    let activated = 0;
    for (const { c, plan: p, run } of planned) {
      const group = matchingGroups(c)[0];
      const active = group?.activeTabId ?? null;
      const activeCloses =
        active !== null &&
        run.closed.some((tab) => tab.key === existingKey(active));
      const kinds = p.steps.map((step) => step.kind);
      const at = kinds.indexOf("activate-status-page");
      assert.equal(
        kinds.filter((kind) => kind === "activate-status-page").length,
        c.state.statusPage && activeCloses ? 1 : 0,
        label(c),
      );
      if (at !== -1) {
        activated += 1;
        const firstClose = kinds.indexOf("close");
        assert.ok(firstClose === -1 || at < firstClose, label(c));
        assert.deepEqual(
          p.steps[at],
          {
            kind: "activate-status-page",
            tabId: group?.tabs.find((tab) => tab.kind === "status")?.id ?? null,
            replacing: active,
          },
          label(c),
        );
      }
    }
    assert.ok(activated > 100, "the generator rarely closes the active tab");
  });

  it("opens every URL in order, even one a tab already shows", () => {
    let shown = 0;
    for (const { c, run } of planned) {
      assert.deepEqual(
        run.opened.flatMap(urlTab),
        c.request.urls.map((url, index) => ({ key: `new url ${index}`, url })),
        label(c),
      );
      const urls = new Set(matchingGroups(c)[0]?.tabs.map((tab) => tab.url));
      shown += c.request.urls.filter((url) => urls.has(url)).length;
    }
    assert.ok(shown > 100, "the generator rarely repeats a shown URL");
  });

  it("waits last, once, for exactly the URL tabs it opened", () => {
    for (const { c, plan: p, run } of planned) {
      const waits = p.steps.filter((step) => step.kind === "wait-for-load");
      assert.deepEqual(
        run.waited.flatMap(urlTab),
        run.opened.flatMap(urlTab),
        label(c),
      );
      // Only URL tabs: the extension's own pages are not waited for.
      assert.equal(run.waited.length, c.request.urls.length, label(c));
      assert.equal(waits.length, c.request.urls.length > 0 ? 1 : 0, label(c));
      assert.ok(
        waits.every(
          (step) =>
            step === p.steps.at(-1) && step.timeoutMs === LOAD_TIMEOUT_MS,
        ),
        label(c),
      );
    }
  });

  it("reports what the steps do", () => {
    for (const { c, plan: p, run } of planned) {
      const closedOther = run.closed.filter((tab) => tab.kind === "other");
      const report: Pick<Plan, "opened" | "closed" | "unchecked"> = {
        opened: p.opened,
        closed: p.closed,
        unchecked: p.unchecked,
      };
      assert.deepEqual(
        report,
        {
          opened: run.opened.filter((tab) => tab.role === "url").length,
          closed: closedOther.length,
          unchecked: closedOther.filter((tab) => tab.form === "unchecked")
            .length,
        },
        label(c),
      );
      assert.deepEqual(
        p.kept,
        (matchingGroups(c)[0]?.tabs ?? [])
          .filter((tab) => tab.kind === "other" && tab.form === "unsubmitted")
          .map(({ url, title }) => ({ url, title })),
        label(c),
      );
      assert.equal(p.created, matchingGroups(c).length === 0, label(c));
    }
  });

  it("collapses a collapsed group last before waiting, and sets a new colour", () => {
    for (const { c, plan: p, run } of planned) {
      const group = matchingGroups(c)[0];
      const kinds = p.steps.map((step) => step.kind);
      const tail = kinds.filter((kind) => kind !== "wait-for-load").at(-1);
      assert.equal(run.final.collapsed, group?.collapsed ?? false, label(c));
      assert.equal(tail === "collapse", group?.collapsed === true, label(c));
      assert.equal(
        run.final.color,
        c.request.color ?? group?.color ?? null,
        label(c),
      );
      assert.equal(
        kinds.includes("set-color"),
        group !== undefined &&
          c.request.color !== undefined &&
          c.request.color !== group.color,
        label(c),
      );
    }
  });
});
