// `set` with the status page, against the fake Chrome: the group's first
// tab is the status page, which is never closed while on and closed when
// off; it is the only tab ever made active, and only in place of the
// window's active tab when the request closes that tab; and each step is
// written to the session storage the page reads.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handleRequest } from "../../src/extension/commands.ts";
import type { Plan } from "../../src/extension/plan.ts";
import {
  requestFinished,
  requestStarted,
} from "../../src/extension/progress.ts";
import {
  progressKey,
  progressReport,
} from "../../src/extension/progress-store.ts";
import { runPlan } from "../../src/extension/run-plan.ts";
import {
  failure,
  type Response,
  type SetRequest,
} from "../../src/protocol/index.ts";
import {
  EMPTY_PAGE,
  type Fake,
  fakeChrome,
  fakeSession,
  groupTabs,
  type ServiceOptions,
  servicesOf,
  settled,
  STATUS_PAGE,
  tab,
  type World,
  world,
} from "./fake-chrome.ts";

const A = "https://a.example/";
const B = "https://b.example/";
const C = "https://c.example/";

const STATUS = `${STATUS_PAGE}?group=Reading`;
const EMPTY = `${EMPTY_PAGE}?group=Reading`;

const set = (
  urls: readonly string[],
  fields: { statusPage?: boolean } = {},
): SetRequest => ({
  protocol: 1,
  command: "set",
  group: "Reading",
  urls,
  ...fields,
});

/** Window 1, focused last: tab 1 loose, the group "Reading" (id 50) of `tabs`, then tab 9 loose. */
const withReading = (
  tabs: readonly number[],
  fields: Partial<World> = {},
): World =>
  world({
    windows: [
      { id: 1, type: "normal", focused: true, tabIds: [1, ...tabs, 9] },
    ],
    tabs: [
      tab(1, 1),
      ...tabs.map((id) => tab(id, 1, { groupId: 50 })),
      tab(9, 1),
    ],
    groups: [
      {
        id: 50,
        windowId: 1,
        title: "Reading",
        color: "blue",
        collapsed: false,
      },
    ],
    lastFocused: 1,
    ...fields,
  });

/** The same world with tab `id` changed. */
const changing = (
  start: World,
  id: number,
  fields: Partial<World["tabs"][number]>,
): World => ({
  ...start,
  tabs: start.tabs.map((each) =>
    each.id === id ? { ...each, ...fields } : each,
  ),
});

const run = async (
  start: World,
  requests: readonly SetRequest[],
  options: ServiceOptions = {},
): Promise<{
  readonly fake: Fake;
  readonly responses: readonly Response[];
}> => {
  const fake = fakeChrome(start);
  const services = servicesOf(fake, options);
  const responses: Response[] = [];
  for (const request of requests) {
    responses.push(await handleRequest(services, request));
  }
  return { fake, responses };
};

const urls = (fake: Fake): readonly string[] =>
  groupTabs(fake.world(), "Reading").map((each) => each.url);

const callsTo = (fake: Fake, operation: string) =>
  fake.calls().filter((call) => call.operation === operation);

/** Every tab and window the extension made opened inactive and unfocused. */
const assertNothingFocused = (fake: Fake): void => {
  for (const call of fake.calls()) {
    const args = call.args[0] as { active?: unknown; focused?: unknown };
    if (call.operation === "tabs.create") {
      assert.equal(args.active, false, JSON.stringify(call));
    }
    if (call.operation === "windows.create") {
      assert.equal(args.focused, false, JSON.stringify(call));
    }
  }
};

/** The tabs `tabs.update` made active, by URL, in order. */
const activatedUrls = (fake: Fake, before: World): readonly string[] =>
  callsTo(fake, "tabs.update").map((call) => {
    const [tabId, properties] = call.args as [number, unknown];
    assert.deepEqual(properties, { active: true });
    const activated =
      fake.world().tabs.find((each) => each.id === tabId) ??
      before.tabs.find((each) => each.id === tabId);
    return activated?.url ?? `closed tab ${tabId}`;
  });

const statusIds = (fake: Fake): readonly number[] =>
  groupTabs(fake.world(), "Reading")
    .filter((each) => each.url === STATUS)
    .map((each) => each.id);

describe("set with the status page on", () => {
  it("makes it the first tab of an existing group", async () => {
    const { fake, responses } = await run(withReading([2, 3]), [set([A, B])]);
    assert.equal(responses[0]?.ok, true);
    assert.deepEqual(urls(fake), [STATUS, A, B]);
    assert.deepEqual(fake.world().windows[0]?.tabIds.at(-1), 9);
    assertNothingFocused(fake);
  });

  it("makes a new group from it", async () => {
    const start = world({
      windows: [{ id: 1, type: "normal", focused: true, tabIds: [1] }],
      tabs: [tab(1, 1, { active: true })],
      lastFocused: 1,
    });
    const { fake, responses } = await run(start, [set([A, B])]);
    assert.deepEqual(
      responses[0]?.ok && responses[0].command === "set" && responses[0].group,
      { title: "Reading", windowId: 1, created: true },
    );
    assert.deepEqual(urls(fake), [STATUS, A, B]);
    assert.deepEqual(callsTo(fake, "tabs.update"), []);
    assertNothingFocused(fake);
  });

  it("leaves it alone in the group for an empty list, new or existing", async () => {
    const existing = await run(withReading([2, 3]), [set([])]);
    assert.deepEqual(urls(existing.fake), [STATUS]);
    const created = await run(
      world({
        windows: [{ id: 1, type: "normal", focused: true, tabIds: [1] }],
        tabs: [tab(1, 1)],
        lastFocused: 1,
      }),
      [set([])],
    );
    assert.deepEqual(urls(created.fake), [STATUS]);
  });

  it("never closes it, request after request", async () => {
    const { fake } = await run(withReading([2]), [
      set([A]),
      set([B, C]),
      set([]),
      set([A]),
    ]);
    const [status] = statusIds(fake);
    assert.ok(status !== undefined);
    assert.deepEqual(statusIds(fake), [status]);
    for (const call of callsTo(fake, "tabs.remove")) {
      assert.equal((call.args[0] as number[]).includes(status), false);
    }
    assert.deepEqual(urls(fake), [STATUS, A]);
  });

  it("is turned on by the request over the setting", async () => {
    const { fake } = await run(
      withReading([2]),
      [set([A], { statusPage: true })],
      {
        statusPage: false,
      },
    );
    assert.deepEqual(urls(fake), [STATUS, A]);
  });
});

describe("set with the status page off", () => {
  const holdingStatus = changing(withReading([5, 2]), 5, { url: STATUS });

  it("closes the status page an existing group has, keeping the group's place", async () => {
    const { fake, responses } = await run(holdingStatus, [set([A])], {
      statusPage: false,
    });
    assert.deepEqual(urls(fake), [A]);
    const strip = fake.world().windows[0]?.tabIds ?? [];
    const groupTab = groupTabs(fake.world(), "Reading")[0];
    assert.deepEqual(
      strip.map((id) => (id === groupTab?.id ? "A" : id)),
      [1, "A", 9],
    );
    assert.deepEqual(
      responses[0]?.ok && responses[0].command === "set" && responses[0].closed,
      1,
      "the status page is not counted as closed",
    );
  });

  it("is turned off by the request over the setting", async () => {
    const { fake } = await run(holdingStatus, [
      set([A], { statusPage: false }),
    ]);
    assert.deepEqual(urls(fake), [A]);
  });

  it("leaves the empty page for an empty list", async () => {
    const { fake } = await run(holdingStatus, [set([])], { statusPage: false });
    assert.deepEqual(urls(fake), [EMPTY]);
  });
});

describe("the status page becoming the active tab", () => {
  const activeIs = (fake: Fake): readonly string[] =>
    fake
      .world()
      .tabs.filter((each) => each.active)
      .map((each) => each.url);

  it("takes the place of the window's active tab that the request closes", async () => {
    const start = changing(withReading([2, 3]), 3, { active: true });
    const { fake } = await run(start, [set([A])]);
    assert.deepEqual(activatedUrls(fake, start), [STATUS]);
    assert.deepEqual(activeIs(fake), [STATUS]);
    const [update] = callsTo(fake, "tabs.update");
    const [remove] = callsTo(fake, "tabs.remove");
    assert.ok(
      fake.calls().indexOf(update!) < fake.calls().indexOf(remove!),
      "it is activated before the active tab closes",
    );
    assertNothingFocused(fake);
  });

  it("does not displace a tab kept for its unsubmitted form", async () => {
    const start = changing(withReading([2, 3]), 3, {
      active: true,
      frames: [{ result: true }],
    });
    const { fake } = await run(start, [set([A])]);
    assert.deepEqual(callsTo(fake, "tabs.update"), []);
    assert.deepEqual(activeIs(fake), ["https://example.com/3"]);
  });

  it("does not displace a tab outside the group", async () => {
    const start = changing(withReading([2, 3]), 1, { active: true });
    const { fake } = await run(start, [set([A])]);
    assert.deepEqual(callsTo(fake, "tabs.update"), []);
    assert.deepEqual(activeIs(fake), ["https://example.com/1"]);
  });

  it("does nothing when the status page is already the active tab", async () => {
    const start = changing(withReading([5, 2]), 5, {
      url: STATUS,
      active: true,
    });
    const { fake } = await run(start, [set([A])]);
    assert.deepEqual(callsTo(fake, "tabs.update"), []);
    assert.deepEqual(activeIs(fake), [STATUS]);
  });

  it("activates nothing with the status page off: Chrome picks the next tab", async () => {
    const start = changing(withReading([2, 3]), 3, { active: true });
    const { fake } = await run(start, [set([A])], { statusPage: false });
    assert.deepEqual(callsTo(fake, "tabs.update"), []);
  });

  it("activates no tab but the status page, over many requests", async () => {
    const start = changing(withReading([2, 3, 4]), 4, { active: true });
    const requests = [
      set([A, B]),
      set([C]),
      set([], { statusPage: false }),
      set([A]),
      set([B], { statusPage: false }),
      set([A, C]),
    ];
    const fake = fakeChrome(start);
    const services = servicesOf(fake);
    const activated: string[] = [];
    for (const request of requests) {
      // The user makes the group's last tab active before each request.
      const last = groupTabs(fake.world(), "Reading").at(-1);
      if (last !== undefined) {
        await fake.tabStrip.tabs.update(last.id, { active: true });
      }
      const before = fake.world();
      const seen = callsTo(fake, "tabs.update").length;
      assert.equal((await handleRequest(services, request)).ok, true);
      activated.push(...activatedUrls(fake, before).slice(seen));
    }
    assert.ok(activated.length > 0);
    assert.ok(
      activated.every((url) => url === STATUS),
      activated.join(", "),
    );
    assertNothingFocused(fake);
  });
});

describe("the interpreter's activation", () => {
  const statusFirst = changing(
    changing(withReading([5, 2]), 5, { url: STATUS }),
    2,
    {
      active: true,
    },
  );
  const planActivating = (tabId: number, replacing: number): Plan => ({
    group: { kind: "existing", groupId: 50, windowId: 1 },
    steps: [{ kind: "activate-status-page", tabId, replacing }],
    created: false,
    opened: 0,
    closed: 0,
    kept: [],
    unchecked: 0,
  });

  it("activates the status page while the tab it replaces is active", async () => {
    const fake = fakeChrome(statusFirst);
    await runPlan(servicesOf(fake), "Reading", planActivating(5, 2));
    assert.deepEqual(
      callsTo(fake, "tabs.update").map((call) => call.args),
      [[5, { active: true }]],
    );
  });

  it("skips it once the tab it replaces is no longer active", async () => {
    const fake = fakeChrome(statusFirst);
    await runPlan(servicesOf(fake), "Reading", planActivating(5, 9));
    assert.deepEqual(callsTo(fake, "tabs.update"), []);
  });

  it("never activates a tab that is not the status page", async () => {
    const fake = fakeChrome(statusFirst);
    const response = await runPlan(
      servicesOf(fake),
      "Reading",
      planActivating(2, 2),
    );
    assert.equal(response.ok, true);
    assert.deepEqual(callsTo(fake, "tabs.update"), []);
  });

  it("never activates the status page once it has left the plan's window", async () => {
    const moved: World = {
      ...statusFirst,
      windows: [
        { id: 1, type: "normal", focused: true, tabIds: [1, 2, 9] },
        { id: 2, type: "normal", focused: false, tabIds: [5] },
      ],
      tabs: statusFirst.tabs.map((each) =>
        each.id === 5 ? { ...each, windowId: 2, groupId: -1 } : each,
      ),
    };
    const fake = fakeChrome(moved);
    await runPlan(servicesOf(fake), "Reading", planActivating(5, 2));
    assert.deepEqual(callsTo(fake, "tabs.update"), []);
  });

  it("never activates the status page once it has left the group", async () => {
    const fake = fakeChrome(changing(statusFirst, 5, { groupId: -1 }));
    await runPlan(servicesOf(fake), "Reading", planActivating(5, 2));
    assert.deepEqual(callsTo(fake, "tabs.update"), []);
  });

  it("calls Chrome no more once the request is given up", async () => {
    const given = new AbortController();
    // Given up while it reads the window's active tab.
    const fake = fakeChrome(statusFirst, {
      before: (operation, w) => {
        if (operation === "tabs.query") {
          given.abort(new Error("past its deadline"));
        }
        return w;
      },
    });
    await runPlan(
      { ...servicesOf(fake), signal: given.signal },
      "Reading",
      planActivating(5, 2),
    );
    assert.deepEqual(
      fake.calls().map((call) => call.operation),
      ["tabs.query"],
    );
  });
});

describe("the progress the status page reads", () => {
  it("ends with every line done and the request in the log", async () => {
    const session = fakeSession();
    const fake = fakeChrome(withReading([2, 3]), {
      loadMs: (url) => (url === B ? 2_000 : 500),
    });
    const services = servicesOf(fake, { session });
    assert.equal((await handleRequest(services, set([A, B, C]))).ok, true);
    await settled();
    const writes = session.writes();
    assert.ok(writes.length > 10, `${writes.length} writes`);
    assert.ok(writes.every((write) => write.key === progressKey("Reading")));
    const last = writes.at(-1)?.value;
    assert.ok(last !== undefined);
    assert.equal(last.current, null);
    assert.equal(last.pages, 3);
    assert.ok(last.log !== null);
    assert.deepEqual(last.log.outcome, {
      ok: true,
      opened: 3,
      closed: 2,
      kept: 0,
      unchecked: 0,
      loading: 0,
    });
    for (const stage of last.log.stages) {
      assert.equal(stage.state, "done", stage.kind);
      for (const line of stage.lines) {
        assert.equal(line.state, "done", `${stage.kind} ${line.key}`);
      }
    }
    assert.deepEqual(
      last.log.stages.map((stage) => [stage.kind, stage.lines.length]),
      [
        ["check", 2],
        ["close", 2],
        ["open", 3],
        ["load", 3],
      ],
    );
    // The first write is the request starting; part-way, a line ran.
    assert.notEqual(writes[0]?.value.current, null);
    assert.ok(
      writes.some((write) =>
        write.value.current?.stages.some((stage) =>
          stage.lines.some((line) => line.state === "running"),
        ),
      ),
    );
  });

  it("keeps the log until the next request starts", async () => {
    const session = fakeSession();
    const fake = fakeChrome(withReading([2]));
    const services = servicesOf(fake, { session });
    await handleRequest(services, set([A]));
    await settled();
    const before = session.writes().length;
    await handleRequest(services, set([B]));
    await settled();
    const next = session.writes()[before]?.value;
    assert.equal(next?.log, null);
    assert.deepEqual(next?.current?.urls, [B]);
  });

  it("ends a request answered at its deadline with that failure", async () => {
    const session = fakeSession();
    let queries = 0;
    const fake = fakeChrome(withReading([2]), {
      hang: (operation) =>
        operation === "tabGroups.query" && (queries += 1) === 1,
    });
    const services = servicesOf(fake, { session });
    const timedOut = await handleRequest(services, set([A]));
    assert.equal(timedOut.ok, false);
    await settled();
    const ended = session.writes().at(-1)?.value;
    assert.equal(ended?.current, null);
    assert.deepEqual(ended?.log?.outcome, {
      ok: false,
      code: "internal",
      message: "the extension did not answer within 90 seconds",
    });
    assert.equal(ended?.pages, null);
    assert.equal((await handleRequest(services, set([B]))).ok, true);
    await settled();
    assert.equal(session.writes().at(-1)?.value.log?.outcome?.ok, true);
  });

  it("writes nothing a request reports after its end", async () => {
    const session = fakeSession();
    const report = progressReport(session.storage, "Reading");
    report(requestStarted(set([A]), 0));
    report(
      requestFinished(failure("internal", "the request took too long"), 1),
    );
    await settled();
    const ended = session.writes().length;
    assert.equal(ended, 2);
    report({ kind: "tab-checked", tabId: 2, form: "clean" });
    report(requestStarted(set([B]), 2));
    await settled();
    assert.equal(session.writes().length, ended);
  });
});

describe("a status page naming another group", () => {
  const own = `${STATUS_PAGE}?group=Reading`;

  it("is closed after a rename, uncounted, and a fresh one opens first", async () => {
    // The group was "Old" when its status page opened.
    const start = changing(withReading([4, 2]), 4, {
      url: `${STATUS_PAGE}?group=Old`,
    });
    const { fake, responses } = await run(start, [set([A])]);
    assert.deepEqual(urls(fake), [own, A]);
    assert.equal(
      fake.world().tabs.some((each) => each.id === 4),
      false,
    );
    const [response] = responses;
    assert.ok(response?.ok === true && response.command === "set");
    assert.equal(response.closed, 1, "only the page closes that counts");
  });

  it("is closed ahead of the group's own, which stays", async () => {
    const start = changing(
      changing(withReading([4, 5, 2]), 4, {
        url: `${STATUS_PAGE}?group=Elsewhere`,
      }),
      5,
      { url: own },
    );
    const { fake, responses } = await run(start, [set([A])]);
    assert.deepEqual(
      groupTabs(fake.world(), "Reading").map((each) => [each.id, each.url]),
      [
        [5, own],
        [fake.world().tabs.find((each) => each.url === A)?.id, A],
      ],
    );
    const [response] = responses;
    assert.ok(response?.ok === true && response.command === "set");
    assert.equal(response.closed, 1);
  });

  it("is never made active", async () => {
    const start = changing(
      changing(withReading([4, 2]), 4, {
        url: `${STATUS_PAGE}?group=Elsewhere`,
      }),
      2,
      { active: true },
    );
    const fake = fakeChrome(start);
    await runPlan(servicesOf(fake), "Reading", {
      group: { kind: "existing", groupId: 50, windowId: 1 },
      steps: [{ kind: "activate-status-page", tabId: 4, replacing: 2 }],
      created: false,
      opened: 0,
      closed: 0,
      kept: [],
      unchecked: 0,
    });
    assert.deepEqual(callsTo(fake, "tabs.update"), []);
  });
});
