// The extension never focuses a window or activates a tab. The narrowed
// interface is the guarantee, so its operations are pinned here: adding
// one, such as `windows.update`, fails the first test. The rest check that
// `narrowTabStrip` passes Chrome only the interface's operations and named
// fields, that no other module names Chrome, and that every tab and window
// the commands create opens inactive and unfocused.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { transformSync } from "esbuild";

import { handleRequest } from "../../src/extension/commands.ts";
import { hasUnsubmittedForm } from "../../src/extension/form-check.ts";
import {
  type ChromeTabStrip,
  narrowTabStrip,
  type TabStrip,
} from "../../src/extension/tab-strip.ts";
import type { SetRequest } from "../../src/protocol/index.ts";
import {
  type Call,
  type Fake,
  fakeChrome,
  servicesOf,
  tab,
  world,
} from "./fake-chrome.ts";

/** Every operation of the narrowed interface; none can focus. */
const OPERATIONS = [
  "tabs.query",
  "tabs.get",
  "tabs.create",
  "tabs.group",
  "tabs.move",
  "tabs.remove",
  "tabGroups.query",
  "tabGroups.update",
  "windows.getAll",
  "windows.getLastFocused",
  "windows.create",
  "scripting.executeScript",
  "extension.isAllowedFileSchemeAccess",
];

/** The only source files that may name the `chrome` global. */
const CHROME_EDGES = ["src/extension/background.ts"];

const operationNames = (api: object): readonly string[] =>
  Object.entries(api).flatMap(([namespace, members]) =>
    Object.keys(members as object).map((name) => `${namespace}.${name}`),
  );

/**
 * A value's shape: an object's keys, sorted, each with its value's shape;
 * an array's or a primitive's type.
 */
const shape = (value: unknown): unknown =>
  Array.isArray(value)
    ? "array"
    : typeof value === "object" && value !== null
      ? Object.fromEntries(
          Object.keys(value)
            .toSorted()
            .map((key) => [
              key,
              shape((value as Record<string, unknown>)[key]),
            ]),
        )
      : typeof value;

/** Every shape of arguments Chrome may receive, by operation. */
const ARGUMENTS: { readonly [operation: string]: readonly unknown[] } = {
  "tabs.query": [[{ groupId: "number" }]],
  "tabs.get": [["number"]],
  "tabs.create": [
    [{ active: "boolean", url: "string", windowId: "number" }],
    [{ active: "boolean", index: "number", url: "string", windowId: "number" }],
  ],
  "tabs.group": [
    [{ groupId: "number", tabIds: "number" }],
    [{ createProperties: { windowId: "number" }, tabIds: "number" }],
  ],
  "tabs.move": [["number", { index: "number" }]],
  "tabs.remove": [["array"]],
  "tabGroups.query": [[{}]],
  "tabGroups.update": [
    ["number", { collapsed: "boolean" }],
    ["number", { color: "string" }],
    ["number", { title: "string" }],
    ["number", { color: "string", title: "string" }],
  ],
  "windows.getAll": [[{ windowTypes: "array" }]],
  "windows.getLastFocused": [[{ windowTypes: "array" }]],
  "windows.create": [[{ focused: "boolean", type: "string", url: "string" }]],
  "scripting.executeScript": [
    [
      {
        func: "function",
        injectImmediately: "boolean",
        target: { allFrames: "boolean", tabId: "number" },
      },
    ],
  ],
  "extension.isAllowedFileSchemeAccess": [[]],
};

const assertArguments = (calls: readonly Call[]): void => {
  for (const call of calls) {
    const allowed = ARGUMENTS[call.operation] ?? [];
    const received = call.args.map(shape);
    assert.ok(
      allowed.some((each) => {
        try {
          assert.deepEqual(received, each);
          return true;
        } catch {
          return false;
        }
      }),
      `${call.operation} received ${JSON.stringify(received)}`,
    );
  }
};

/**
 * A stand-in for Chrome that records every member path read from it, such
 * as "tabs.create", and every call's arguments; each function resolves to
 * `undefined`.
 */
const recordingChrome = (): {
  readonly chrome: ChromeTabStrip;
  readonly touched: string[];
  readonly calls: Call[];
} => {
  const touched: string[] = [];
  const calls: Call[] = [];
  const namespace = (name: string): object =>
    new Proxy(
      {},
      {
        get: (_, member) => {
          const operation = `${name}.${String(member)}`;
          touched.push(operation);
          return (...args: unknown[]) => {
            calls.push({ operation, args });
            return Promise.resolve(undefined);
          };
        },
      },
    );
  const chrome = new Proxy(
    {},
    { get: (_, name) => namespace(String(name)) },
  ) as ChromeTabStrip;
  return { chrome, touched, calls };
};

/**
 * Calls every operation with arguments carrying fields Chrome would act on
 * but the interface does not name, such as `openerTabId`, `state`, or a
 * function of its own for `executeScript` to inject.
 */
const callEvery = async (api: TabStrip): Promise<void> => {
  const extra = { active: true, focused: true, state: "maximized" };
  const query = { groupId: 1, active: true };
  await api.tabs.query(query);
  await api.tabs.get(1);
  const created = {
    windowId: 1,
    url: "https://a.example/",
    active: false as const,
    openerTabId: 2,
    pinned: true,
  };
  await api.tabs.create(created);
  const grouped = { tabIds: 1, groupId: 1, ...extra };
  await api.tabs.group(grouped);
  const moved = { index: 0, windowId: 2 };
  await api.tabs.move(1, moved);
  await api.tabs.remove([1]);
  await api.tabGroups.query({});
  const updated = { collapsed: true, ...extra };
  await api.tabGroups.update(1, updated);
  const normal = { windowTypes: ["normal" as const], populate: true };
  await api.windows.getAll(normal);
  await api.windows.getLastFocused(normal);
  const window = {
    url: "https://a.example/",
    focused: false as const,
    type: "normal" as const,
    state: "fullscreen",
  };
  await api.windows.create(window);
  const injection = {
    target: { tabId: 1, allFrames: true as const, frameIds: [0] },
    func: () => false,
    injectImmediately: true as const,
    world: "MAIN",
  };
  await api.scripting.executeScript(injection);
  await api.extension.isAllowedFileSchemeAccess();
};

describe("the narrowed tab strip", () => {
  it("lists exactly these operations, none of which can focus", () => {
    const { chrome } = recordingChrome();
    assert.deepEqual(operationNames(narrowTabStrip(chrome)), OPERATIONS);
    assert.deepEqual(operationNames(fakeChrome(world()).tabStrip), OPERATIONS);
    for (const focusing of [
      "windows.update",
      "tabs.update",
      "tabs.highlight",
    ]) {
      assert.equal(OPERATIONS.includes(focusing), false);
    }
  });

  it("reaches nothing of Chrome but its own operations and named fields", async () => {
    const { chrome, touched, calls } = recordingChrome();
    const narrowed = narrowTabStrip(chrome);
    assert.deepEqual(touched, [], "narrowing reads nothing of Chrome");
    await callEvery(narrowed);
    assert.deepEqual(touched, OPERATIONS);
    assertArguments(calls);
    assert.deepEqual(
      calls.find((call) => call.operation === "tabs.create")?.args,
      [{ windowId: 1, url: "https://a.example/", active: false }],
    );
  });

  it("injects only the form check, whatever function a caller passes", async () => {
    const { chrome, calls } = recordingChrome();
    await callEvery(narrowTabStrip(chrome));
    const injected = calls.filter(
      (call) => call.operation === "scripting.executeScript",
    );
    assert.deepEqual(injected, [
      {
        operation: "scripting.executeScript",
        args: [
          {
            target: { tabId: 1, allFrames: true },
            func: hasUnsubmittedForm,
            injectImmediately: true,
          },
        ],
      },
    ]);
  });

  it("is named, as the chrome global, only in the edges", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const sources = readdirSync(join(root, "src"), {
      recursive: true,
      encoding: "utf8",
    })
      .filter((path) => path.endsWith(".ts"))
      .map((path) => join("src", path));
    assert.ok(sources.includes("src/extension/tab-strip.ts"));
    // esbuild drops the comments and types, so only code is searched.
    const naming = sources.filter((path) =>
      /\bchrome\./.test(
        transformSync(readFileSync(join(root, path), "utf8"), {
          loader: "ts",
        }).code,
      ),
    );
    assert.deepEqual(naming, CHROME_EDGES);
  });
});

const creates = (fake: Fake) =>
  fake
    .calls()
    .filter(
      (call) =>
        call.operation === "tabs.create" || call.operation === "windows.create",
    );

const set = (urls: readonly string[], createWindow = false): SetRequest => ({
  protocol: 1,
  command: "set",
  group: "Reading",
  urls,
  createWindow,
});

describe("set never focuses", () => {
  it("opens every tab inactive and every window unfocused", async () => {
    const fake = fakeChrome(world());
    const services = servicesOf(fake);
    const requests = [
      set(["https://a.example/", "https://b.example/"], true),
      set(["https://c.example/"]),
      set([]),
      set(["https://d.example/", "https://e.example/", "https://f.example/"]),
    ];
    for (const request of requests) {
      assert.equal((await handleRequest(services, request)).ok, true);
    }
    const made = creates(fake);
    assert.deepEqual(
      made.map((call) => call.operation),
      [
        "windows.create",
        "tabs.create",
        "tabs.create",
        "tabs.create",
        "tabs.create",
        "tabs.create",
        "tabs.create",
      ],
    );
    for (const call of made) {
      const args = call.args[0] as { active?: unknown; focused?: unknown };
      assert.equal(
        call.operation === "tabs.create" ? args.active : args.focused,
        false,
        JSON.stringify(call),
      );
    }
    assertArguments(fake.calls());
    // The new window's first tab, its only one, was the one active tab, and
    // the second request closed it.
    assert.deepEqual(
      fake.world().tabs.filter((each) => each.active),
      [],
      "no tab the extension opened is active",
    );
  });

  it("leaves the user's active tab and focused window as they were", async () => {
    const start = world({
      windows: [{ id: 1, type: "normal", focused: true, tabIds: [1, 2] }],
      tabs: [tab(1, 1, { active: true }), tab(2, 1, { groupId: 50 })],
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
    });
    const fake = fakeChrome(start);
    await handleRequest(servicesOf(fake), set(["https://a.example/"]));
    assert.deepEqual(
      fake
        .world()
        .tabs.filter((each) => each.active)
        .map((each) => each.id),
      [1],
    );
    assert.deepEqual(
      fake.world().windows.map(({ id, focused }) => ({ id, focused })),
      [{ id: 1, focused: true }],
    );
    assert.equal(fake.world().lastFocused, 1);
  });
});
