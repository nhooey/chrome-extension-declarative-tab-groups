// The store of each group's progress: a storage that refuses or never
// answers holds up and fails no request, and the requests a stopped
// service worker left under way are ended as interrupted.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handleRequest } from "../../src/extension/commands.ts";
import {
  advance,
  idle,
  type Progress,
  requestStarted,
} from "../../src/extension/progress.ts";
import {
  endInterrupted,
  INTERRUPTED,
  interruptedProgress,
  progressKey,
  readProgress,
} from "../../src/extension/progress-store.ts";
import type { SetRequest } from "../../src/protocol/index.ts";
import {
  fakeChrome,
  fakeSession,
  type SessionOptions,
  servicesOf,
  settled,
  tab,
  world,
} from "./fake-chrome.ts";

const set = (urls: readonly string[], group = "Reading"): SetRequest => ({
  protocol: 1,
  command: "set",
  group,
  urls,
});

/** Window 1, focused last, with the group "Reading" (id 50) of tab 2. */
const reading = world({
  windows: [{ id: 1, type: "normal", focused: true, tabIds: [1, 2] }],
  tabs: [tab(1, 1), tab(2, 1, { groupId: 50 })],
  groups: [
    { id: 50, windowId: 1, title: "Reading", color: "blue", collapsed: false },
  ],
  lastFocused: 1,
});

/** The group titled `title` with a request under way, as a stopped worker leaves it. */
const running = (title: string): Progress =>
  advance(idle(title), requestStarted(set(["https://a.example/"], title), 10));

/** The same group once its request has ended well. */
const finished = (title: string): Progress =>
  advance(running(title), {
    kind: "request-finished",
    at: 20,
    outcome: {
      ok: true,
      opened: 1,
      closed: 0,
      kept: 0,
      unchecked: 0,
      loading: 0,
    },
  });

describe("readProgress", () => {
  it("reads an idle progress when the storage refuses or holds none", async () => {
    assert.deepEqual(
      await readProgress(fakeSession({ reject: "get" }).storage, "Reading"),
      idle("Reading"),
    );
    assert.deepEqual(
      await readProgress(
        fakeSession({ items: { [progressKey("Reading")]: running("Other") } })
          .storage,
        "Reading",
      ),
      idle("Reading"),
    );
  });
});

describe("a report over a storage that fails", () => {
  const faults: readonly (readonly [string, SessionOptions])[] = [
    ["refuses every read", { reject: "get" }],
    ["refuses every write", { reject: "set" }],
    ["refuses everything", { reject: "both" }],
    ["never answers a read", { hang: "get" }],
    ["never answers a write", { hang: "set" }],
    ["never answers at all", { hang: "both" }],
  ];
  for (const [name, options] of faults) {
    it(`neither holds up nor fails a set when the storage ${name}`, async () => {
      const fake = fakeChrome(reading);
      const services = servicesOf(fake, { session: fakeSession(options) });
      const response = await handleRequest(
        services,
        set(["https://a.example/"]),
      );
      assert.equal(response.ok, true, JSON.stringify(response));
      assert.ok(fake.clock.now() < 1_000, `${fake.clock.now()} ms`);
      await settled();
    });
  }

  it("still writes each step when only the first read is refused", async () => {
    const session = fakeSession({ reject: "get" });
    const services = servicesOf(fakeChrome(reading), { session });
    await handleRequest(services, set(["https://a.example/"]));
    await settled();
    const last = session.writes().at(-1)?.value;
    assert.equal(last?.group, "Reading");
    assert.equal(last?.log?.outcome?.ok, true);
  });
});

describe("interruptedProgress", () => {
  it("ends each request under way, and leaves out everything else", () => {
    const ended = interruptedProgress(
      {
        [progressKey("Reading")]: running("Reading"),
        [progressKey("Work")]: finished("Work"),
        [progressKey("Moved")]: running("Elsewhere"),
        [progressKey("Idle")]: idle("Idle"),
        settings: { statusPage: true },
        [progressKey("Broken")]: "not a progress",
      },
      30,
    );
    assert.deepEqual(Object.keys(ended), [progressKey("Reading")]);
    const progress = ended[progressKey("Reading")];
    assert.equal(progress?.current, null);
    assert.equal(progress?.pages, null);
    assert.deepEqual(progress?.log?.outcome, INTERRUPTED);
    assert.equal(progress?.log?.finishedAt, 30);
  });

  it("ends nothing when no request is under way", () => {
    assert.deepEqual(
      interruptedProgress({ [progressKey("Work")]: finished("Work") }, 30),
      {},
    );
  });
});

describe("endInterrupted", () => {
  it("writes the ended progress of each request under way", async () => {
    const session = fakeSession({
      items: {
        [progressKey("Reading")]: running("Reading"),
        [progressKey("Work")]: finished("Work"),
      },
    });
    await endInterrupted(session.storage, 30, new AbortController().signal);
    assert.deepEqual(
      session.writes().map(({ key, value }) => [key, value.log?.outcome]),
      [[progressKey("Reading"), INTERRUPTED]],
    );
  });

  it("writes nothing once its signal aborts, and never rejects", async () => {
    const session = fakeSession({
      items: { [progressKey("Reading")]: running("Reading") },
    });
    const late = new AbortController();
    late.abort();
    await endInterrupted(session.storage, 30, late.signal);
    assert.deepEqual(session.writes(), []);
    await endInterrupted(
      fakeSession({ reject: "both" }).storage,
      30,
      new AbortController().signal,
    );
  });
});
