// `set` end to end: the request read against a fake Chrome, planned and
// carried out, checked on both the fake's final tabs and the response. The
// status page is off here, as the user's setting can make it, so that the
// group holds only the requested pages; status-page.test.ts has it on.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  handleRequest,
  REQUEST_DEADLINE_MS,
} from "../../src/extension/commands.ts";
import { FORM_CHECK_TIMEOUT_MS } from "../../src/extension/read-state.ts";
import {
  DRAG_RETRY_INTERVAL_MS,
  DRAG_RETRY_MS,
} from "../../src/extension/run-plan.ts";
import { LOAD_TIMEOUT_MS } from "../../src/extension/steps.ts";
import {
  type Color,
  failure,
  type Response,
  type SetRequest,
} from "../../src/protocol/index.ts";
import {
  EMPTY_PAGE,
  type Fake,
  type FakeOptions,
  fakeChrome,
  groupTabs,
  servicesOf,
  tab,
  type World,
  world,
} from "./fake-chrome.ts";

const A = "https://a.example/";
const B = "https://b.example/";
const C = "https://c.example/";
const FILE = "FILE:///tmp/notes.html";

/** The user's setting with the status page off. */
const OFF = { statusPage: false };

const set = (
  urls: readonly string[],
  fields: { color?: Color; createWindow?: boolean; group?: string } = {},
): SetRequest => ({
  protocol: 1,
  command: "set",
  group: "Reading",
  urls,
  ...fields,
});

/** Window 1, focused last, holding tab 1 loose and the group "Reading" (id 50) of the tabs given. */
const withReading = (
  tabs: readonly number[],
  group: { color?: Color; collapsed?: boolean } = {},
  fields: Partial<World> = {},
): World =>
  world({
    windows: [{ id: 1, type: "normal", focused: true, tabIds: [1, ...tabs] }],
    tabs: [tab(1, 1), ...tabs.map((id) => tab(id, 1, { groupId: 50 }))],
    groups: [
      {
        id: 50,
        windowId: 1,
        title: "Reading",
        color: group.color ?? "blue",
        collapsed: group.collapsed ?? false,
      },
    ],
    lastFocused: 1,
    ...fields,
  });

const run = async (
  start: World,
  request: SetRequest,
  options: FakeOptions = {},
): Promise<{ readonly fake: Fake; readonly response: Response }> => {
  const fake = fakeChrome(start, options);
  return {
    fake,
    response: await handleRequest(servicesOf(fake, OFF), request),
  };
};

const urls = (fake: Fake, title = "Reading"): readonly string[] =>
  groupTabs(fake.world(), title).map((each) => each.url);

const success = (fields: {
  windowId?: number;
  created?: boolean;
  opened: number;
  closed: number;
  kept?: readonly { url: string; title: string }[];
  unchecked?: number;
  loading?: number;
}): Response => ({
  protocol: 1,
  ok: true,
  command: "set",
  group: {
    title: "Reading",
    windowId: fields.windowId ?? 1,
    created: fields.created ?? false,
  },
  opened: fields.opened,
  closed: fields.closed,
  kept: fields.kept ?? [],
  unchecked: fields.unchecked ?? 0,
  loading: fields.loading ?? 0,
});

describe("set: an existing group", () => {
  it("replaces its tabs with the requested pages, in order", async () => {
    const { fake, response } = await run(withReading([2, 3]), set([A, B]));
    assert.deepEqual(response, success({ opened: 2, closed: 2 }));
    assert.deepEqual(urls(fake), [A, B]);
    assert.deepEqual(
      fake.world().windows[0]?.tabIds.slice(0, 1),
      [1],
      "the loose tab stays where it was",
    );
    assert.equal(fake.world().groups.length, 1);
  });

  it("matches the title exactly", async () => {
    const start = withReading([2]);
    const { fake, response } = await run(
      { ...start, groups: [{ ...start.groups[0]!, title: "reading" }] },
      set([A]),
    );
    assert.deepEqual(
      response,
      success({ created: true, opened: 1, closed: 0 }),
    );
    assert.deepEqual(urls(fake), [A]);
    assert.deepEqual(urls(fake, "reading"), ["https://example.com/2"]);
  });

  it("leaves the empty page alone for an empty list", async () => {
    const { fake, response } = await run(withReading([2, 3]), set([]));
    assert.deepEqual(response, success({ opened: 0, closed: 2 }));
    assert.deepEqual(urls(fake), [`${EMPTY_PAGE}?group=Reading`]);
    const again = await handleRequest(servicesOf(fake, OFF), set([]));
    assert.deepEqual(again, success({ opened: 0, closed: 0 }));
    assert.deepEqual(urls(fake), [`${EMPTY_PAGE}?group=Reading`]);
  });

  it("keeps a tab with an unsubmitted form, and reports it", async () => {
    const start = withReading([2, 3]);
    const { fake, response } = await run(
      {
        ...start,
        tabs: start.tabs.map((each) =>
          each.id === 2 ? { ...each, frames: [{ result: true }] } : each,
        ),
      },
      set([A]),
    );
    assert.deepEqual(
      response,
      success({
        opened: 1,
        closed: 1,
        kept: [{ url: "https://example.com/2", title: "Page 2" }],
      }),
    );
    assert.deepEqual(urls(fake), ["https://example.com/2", A]);
  });

  it("counts a discarded tab as unchecked, without scripting it", async () => {
    const start = withReading([2, 3, 4]);
    const { fake, response } = await run(
      {
        ...start,
        tabs: start.tabs.map((each) =>
          each.id === 2
            ? { ...each, discarded: true }
            : each.id === 3
              ? { ...each, frames: "refused" }
              : each,
        ),
      },
      set([A]),
    );
    assert.deepEqual(response, success({ opened: 1, closed: 3, unchecked: 2 }));
    assert.deepEqual(urls(fake), [A]);
    const scripted = fake
      .calls()
      .filter((call) => call.operation === "scripting.executeScript")
      .map((call) => {
        const { target, injectImmediately } = call.args[0] as {
          target: unknown;
          injectImmediately: unknown;
        };
        return { target, injectImmediately };
      });
    assert.deepEqual(scripted, [
      { target: { tabId: 3, allFrames: true }, injectImmediately: true },
      { target: { tabId: 4, allFrames: true }, injectImmediately: true },
    ]);
  });

  it("counts a frozen tab as unchecked, without scripting it", async () => {
    const start = withReading([2, 3]);
    const { fake, response } = await run(
      {
        ...start,
        tabs: start.tabs.map((each) =>
          each.id === 2 ? { ...each, frozen: true } : each,
        ),
      },
      set([A]),
    );
    assert.deepEqual(response, success({ opened: 1, closed: 2, unchecked: 1 }));
    assert.deepEqual(
      fake
        .calls()
        .filter((call) => call.operation === "scripting.executeScript")
        .map((call) => (call.args[0] as { target: unknown }).target),
      [{ tabId: 3, allFrames: true }],
    );
  });

  it("counts a tab whose form check does not answer within 5 seconds as unchecked", async () => {
    const start = withReading([2, 3]);
    const { fake, response } = await run(
      {
        ...start,
        tabs: start.tabs.map((each) =>
          each.id === 2 ? { ...each, frames: "hang" } : each,
        ),
      },
      set([A]),
    );
    assert.deepEqual(response, success({ opened: 1, closed: 2, unchecked: 1 }));
    assert.deepEqual(urls(fake), [A]);
    assert.equal(fake.clock.now(), FORM_CHECK_TIMEOUT_MS);
  });

  it("keeps the requested order when a tab appears left of the group meanwhile", async () => {
    const foreign = (w: World): World => ({
      ...w,
      windows: w.windows.map((each) => ({
        ...each,
        tabIds: [w.nextId, ...each.tabIds],
      })),
      tabs: [...w.tabs, tab(w.nextId, 1)],
      nextId: w.nextId + 1,
    });
    const { fake, response } = await run(withReading([2, 3]), set([A, B, C]), {
      before: (operation, w) => (operation === "tabs.create" ? foreign(w) : w),
    });
    assert.deepEqual(response, success({ opened: 3, closed: 2 }));
    assert.deepEqual(urls(fake), [A, B, C]);
  });

  it("closes the rest when a tab to close has gone meanwhile", async () => {
    let gone = false;
    const { fake, response } = await run(withReading([2, 3, 4]), set([A]), {
      before: (operation, w) => {
        if (operation !== "tabs.remove" || gone) {
          return w;
        }
        gone = true;
        return {
          ...w,
          tabs: w.tabs.filter((each) => each.id !== 3),
          windows: w.windows.map((each) => ({
            ...each,
            tabIds: each.tabIds.filter((id) => id !== 3),
          })),
        };
      },
    });
    assert.deepEqual(response, success({ opened: 1, closed: 3 }));
    assert.deepEqual(urls(fake), [A]);
    assert.deepEqual(
      fake.world().tabs.map((each) => each.id),
      [1, fake.world().tabs[1]?.id ?? -1],
    );
  });

  it("keeps a collapsed group collapsed", async () => {
    const { fake, response } = await run(
      withReading([2], { collapsed: true }),
      set([A, B]),
    );
    assert.equal(response.ok, true);
    assert.equal(fake.world().groups[0]?.collapsed, true);
    assert.deepEqual(urls(fake), [A, B]);
  });

  it("changes the colour only when asked", async () => {
    const kept = await run(withReading([2]), set([A]));
    assert.equal(kept.fake.world().groups[0]?.color, "blue");
    assert.equal(
      kept.fake
        .calls()
        .some(
          (call) =>
            call.operation === "tabGroups.update" &&
            Object.hasOwn(call.args[1] as object, "color"),
        ),
      false,
    );
    const changed = await run(withReading([2]), set([A], { color: "green" }));
    assert.equal(changed.fake.world().groups[0]?.color, "green");
  });

  it("fails with ambiguous-group when two groups have the title", async () => {
    const start = withReading([2]);
    const { fake, response } = await run(
      {
        ...start,
        windows: [
          ...start.windows,
          { id: 9, type: "normal", focused: false, tabIds: [90] },
        ],
        tabs: [...start.tabs, tab(90, 9, { groupId: 60 })],
        groups: [
          ...start.groups,
          {
            id: 60,
            windowId: 9,
            title: "Reading",
            color: "red",
            collapsed: false,
          },
        ],
      },
      set([A]),
    );
    assert.deepEqual(
      response,
      failure("ambiguous-group", '2 tab groups are titled "Reading"'),
    );
    assert.deepEqual(urls(fake), ["https://example.com/2"]);
  });
});

describe("set: a group that does not exist", () => {
  it("creates it in the last-focused window", async () => {
    const start = world({
      windows: [{ id: 1, type: "normal", focused: true, tabIds: [1] }],
      tabs: [tab(1, 1)],
      lastFocused: 1,
    });
    const { fake, response } = await run(start, set([A, B], { color: "red" }));
    assert.deepEqual(
      response,
      success({ created: true, opened: 2, closed: 0 }),
    );
    assert.deepEqual(urls(fake), [A, B]);
    assert.deepEqual(
      fake.world().groups.map((group) => group.color),
      ["red"],
    );
  });

  it("creates it holding the empty page for an empty list", async () => {
    const start = world({
      windows: [{ id: 1, type: "normal", focused: true, tabIds: [1] }],
      tabs: [tab(1, 1)],
      lastFocused: 1,
    });
    const { fake, response } = await run(start, set([]));
    assert.deepEqual(
      response,
      success({ created: true, opened: 0, closed: 0 }),
    );
    assert.deepEqual(urls(fake), [`${EMPTY_PAGE}?group=Reading`]);
  });

  it("fails with no-window when no window can hold it", async () => {
    const { fake, response } = await run(world(), set([A]));
    assert.deepEqual(
      response,
      failure(
        "no-window",
        'no Chrome window can hold the new group "Reading", and "createWindow" is not true',
      ),
    );
    assert.deepEqual(fake.world().windows, []);
  });

  it("opens an unfocused window for it with createWindow", async () => {
    const { fake, response } = await run(
      world({ nextId: 200 }),
      set([A, B], { createWindow: true }),
    );
    assert.deepEqual(
      response,
      success({ windowId: 200, created: true, opened: 2, closed: 0 }),
    );
    assert.deepEqual(urls(fake), [A, B]);
    assert.deepEqual(
      fake.world().windows.map(({ id, focused }) => ({ id, focused })),
      [{ id: 200, focused: false }],
    );
    assert.equal(fake.world().lastFocused, null);
  });
});

describe("set: Chrome refusing changes while a tab is dragged", () => {
  it("retries a refused change until Chrome takes it", async () => {
    const { fake, response } = await run(withReading([2, 3]), set([A]), {
      dragRefusals: 4,
    });
    assert.deepEqual(response, success({ opened: 1, closed: 2 }));
    assert.deepEqual(urls(fake), [A]);
    assert.equal(fake.clock.now(), 4 * DRAG_RETRY_INTERVAL_MS);
  });

  it("answers busy once Chrome has refused for 5 seconds", async () => {
    const { fake, response } = await run(withReading([2, 3]), set([A]), {
      dragUntil: Number.POSITIVE_INFINITY,
    });
    assert.deepEqual(
      response,
      failure(
        "busy",
        "Chrome refused to change the tab strip for 5 seconds, as it does while a tab is being dragged",
      ),
    );
    assert.ok(fake.clock.now() >= DRAG_RETRY_MS);
    assert.ok(fake.clock.now() < DRAG_RETRY_MS + 1_000);
  });
});

describe("set: waiting for the opened pages to load", () => {
  it("answers once they have loaded", async () => {
    const { fake, response } = await run(withReading([2]), set([A, B]), {
      loadMs: (url) => (url === B ? 3_000 : 1_000),
    });
    assert.deepEqual(response, success({ opened: 2, closed: 1, loading: 0 }));
    assert.ok(fake.clock.now() >= 3_000 && fake.clock.now() < 4_000);
  });

  it("counts the pages still loading after 30 seconds", async () => {
    const { fake, response } = await run(withReading([2]), set([A, B]), {
      loadMs: (url) => (url === A ? Number.POSITIVE_INFINITY : 1_000),
    });
    assert.deepEqual(response, success({ opened: 2, closed: 1, loading: 1 }));
    assert.equal(fake.clock.now(), LOAD_TIMEOUT_MS);
  });
});

describe("set: file URLs", () => {
  it("fails, changing nothing, while file URLs are not allowed", async () => {
    const start = withReading([2, 3]);
    const { fake, response } = await run(start, set([A, FILE]));
    assert.deepEqual(
      response,
      failure(
        "invalid-request",
        'field "urls[1]" is a file URL, and the extension\'s "Allow access to file URLs" setting is off',
      ),
    );
    assert.deepEqual(fake.world(), start);
    assert.deepEqual(
      fake.calls().map((call) => call.operation),
      ["extension.isAllowedFileSchemeAccess"],
    );
  });

  it("opens them once they are allowed", async () => {
    const { fake, response } = await run(withReading([2]), set([FILE]), {
      fileAccess: true,
    });
    assert.deepEqual(response, success({ opened: 1, closed: 1 }));
    assert.deepEqual(urls(fake), [FILE]);
  });

  it("does not ask without a file URL", async () => {
    const { fake } = await run(withReading([2]), set([A]));
    assert.equal(
      fake
        .calls()
        .some(
          (call) => call.operation === "extension.isAllowedFileSchemeAccess",
        ),
      false,
    );
  });
});

describe("set: a request Chrome never answers", () => {
  it("is answered internal after 90 seconds", async () => {
    const { fake, response } = await run(withReading([2]), set([A]), {
      hang: (operation) => operation === "tabGroups.query",
    });
    assert.deepEqual(
      response,
      failure("internal", "the extension did not answer within 90 seconds"),
    );
    assert.equal(fake.clock.now(), REQUEST_DEADLINE_MS);
  });
});
