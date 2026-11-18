import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProgressEvent } from "../../src/extension/progress.ts";
import {
  groupTabKind,
  readGroupState,
  tabKind,
  tabUrl,
} from "../../src/extension/read-state.ts";
import {
  EMPTY_PAGE,
  fakeChrome,
  servicesOf,
  STATUS_PAGE,
  tab,
  world,
} from "./fake-chrome.ts";

const pages = { empty: EMPTY_PAGE, status: STATUS_PAGE };

describe("tabKind", () => {
  it("knows the empty page with any query or fragment", () => {
    assert.equal(tabKind(EMPTY_PAGE, pages), "empty");
    assert.equal(tabKind(`${EMPTY_PAGE}?group=Reading`, pages), "empty");
    assert.equal(tabKind(`${EMPTY_PAGE}#top`, pages), "empty");
  });

  it("knows the status page with any query or fragment", () => {
    assert.equal(tabKind(STATUS_PAGE, pages), "status");
    assert.equal(tabKind(`${STATUS_PAGE}?group=Reading`, pages), "status");
    assert.equal(tabKind(`${STATUS_PAGE}#top`, pages), "status");
  });

  it("calls every other page other", () => {
    for (const url of [
      "https://example.com/empty.html",
      "https://example.com/status.html",
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop/empty.html",
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop/status.html",
      "chrome://newtab/",
      "",
      "not a url",
    ]) {
      assert.equal(tabKind(url, pages), "other", url);
    }
  });
});

describe("groupTabKind", () => {
  it("counts the extension's pages as the group's only when they name it", () => {
    const of = (url: string) => groupTabKind(url, pages, "Read ing");
    assert.equal(of(`${STATUS_PAGE}?group=Read%20ing`), "status");
    assert.equal(of(`${EMPTY_PAGE}?group=Read+ing#top`), "empty");
    assert.equal(of(`${STATUS_PAGE}?group=Reading`), "stray");
    assert.equal(of(`${EMPTY_PAGE}?group=read%20ing`), "stray");
    assert.equal(of(STATUS_PAGE), "stray");
    assert.equal(of("https://example.com/status.html?group=Read+ing"), "other");
  });
});

describe("tabUrl", () => {
  it("is the pending URL while a new tab has none", () => {
    const fields = { index: 0, windowId: 1, groupId: -1, discarded: false };
    assert.equal(
      tabUrl({ ...fields, url: "", pendingUrl: EMPTY_PAGE }),
      EMPTY_PAGE,
    );
    assert.equal(
      tabUrl({ ...fields, url: "https://a.example/" }),
      "https://a.example/",
    );
    assert.equal(tabUrl(fields), "");
  });
});

describe("readGroupState", () => {
  const reading = world({
    windows: [
      { id: 1, type: "normal", focused: false, tabIds: [3, 2, 4] },
      { id: 2, type: "popup", focused: false, tabIds: [9] },
      { id: 5, type: "normal", focused: true, tabIds: [6] },
    ],
    tabs: [
      tab(2, 1, {
        groupId: 50,
        active: true,
        frames: [{ result: false }, { result: true }],
      }),
      tab(3, 1, {
        groupId: 50,
        url: `${EMPTY_PAGE}?group=Reading`,
        title: "Reading (empty)",
      }),
      tab(4, 1, { groupId: 50, unloaded: true }),
      tab(9, 2, { groupId: 60 }),
      tab(6, 5),
    ],
    groups: [
      {
        id: 50,
        windowId: 1,
        title: "Reading",
        color: "cyan",
        collapsed: true,
      },
      {
        id: 60,
        windowId: 2,
        title: "Reading",
        color: "red",
        collapsed: false,
      },
    ],
    lastFocused: 5,
  });

  it("reports the form check as it starts and as each tab's result comes", async () => {
    const events: ProgressEvent[] = [];
    const state = await readGroupState(
      servicesOf(fakeChrome(reading)),
      "Reading",
      {
        statusPage: true,
        report: (event) => {
          events.push(event);
          return Promise.resolve();
        },
      },
    );
    assert.equal(state.statusPage, true);
    assert.deepEqual(events[0], {
      kind: "check-started",
      tabs: [
        { id: 2, url: "https://example.com/2", title: "Page 2" },
        { id: 4, url: "https://example.com/4", title: "Page 4" },
      ],
    });
    assert.deepEqual(
      events
        .slice(1)
        .toSorted((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right)),
        ),
      [
        { kind: "tab-checked", tabId: 2, form: "unsubmitted" },
        { kind: "tab-checked", tabId: 4, form: "unchecked" },
      ],
    );
  });

  it("reads the titled groups of normal windows, each tab's kind and form", async () => {
    const fake = fakeChrome(reading);
    assert.deepEqual(await readGroupState(servicesOf(fake), "Reading"), {
      groups: [
        {
          id: 50,
          title: "Reading",
          color: "cyan",
          collapsed: true,
          windowId: 1,
          tabs: [
            {
              id: 3,
              url: `${EMPTY_PAGE}?group=Reading`,
              title: "Reading (empty)",
              kind: "empty",
            },
            {
              id: 2,
              url: "https://example.com/2",
              title: "Page 2",
              kind: "other",
              form: "unsubmitted",
            },
            {
              id: 4,
              url: "https://example.com/4",
              title: "Page 4",
              kind: "other",
              form: "unchecked",
            },
          ],
          activeTabId: 2,
        },
      ],
      windowId: 5,
      statusPage: false,
    });
  });
});
