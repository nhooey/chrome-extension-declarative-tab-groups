import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  readGroupState,
  tabKind,
  tabUrl,
} from "../../src/extension/read-state.ts";
import {
  EMPTY_PAGE,
  fakeChrome,
  servicesOf,
  tab,
  world,
} from "./fake-chrome.ts";

const pages = { empty: EMPTY_PAGE };

describe("tabKind", () => {
  it("knows the empty page with any query or fragment", () => {
    assert.equal(tabKind(EMPTY_PAGE, pages), "empty");
    assert.equal(tabKind(`${EMPTY_PAGE}?group=Reading`, pages), "empty");
    assert.equal(tabKind(`${EMPTY_PAGE}#top`, pages), "empty");
  });

  it("calls every other page other", () => {
    for (const url of [
      "https://example.com/empty.html",
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop/empty.html",
      `${EMPTY_PAGE.replace("empty.html", "status.html")}`,
      "chrome://newtab/",
      "",
      "not a url",
    ]) {
      assert.equal(tabKind(url, pages), "other", url);
    }
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
  it("reads the titled groups of normal windows, each tab's kind and form", async () => {
    const fake = fakeChrome(
      world({
        windows: [
          { id: 1, type: "normal", focused: false, tabIds: [3, 2, 4] },
          { id: 2, type: "popup", focused: false, tabIds: [9] },
          { id: 5, type: "normal", focused: true, tabIds: [6] },
        ],
        tabs: [
          tab(2, 1, {
            groupId: 50,
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
      }),
    );
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
        },
      ],
      windowId: 5,
      statusPage: false,
    });
  });
});
