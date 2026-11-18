// `get` and `status` against the fake Chrome, and requests waiting their
// turn in their group's queue.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handleRequest, queueKey } from "../../src/extension/commands.ts";
import { MAX_WAITING, queueByKey } from "../../src/extension/queue.ts";
import {
  failure,
  type Request,
  type Response,
} from "../../src/protocol/index.ts";
import {
  EMPTY_PAGE,
  fakeChrome,
  groupTabs,
  servicesOf,
  tab,
  type World,
  world,
} from "./fake-chrome.ts";

const get = (group = "Reading"): Request => ({
  protocol: 1,
  command: "get",
  group,
});

const set = (urls: readonly string[], group = "Reading"): Request => ({
  protocol: 1,
  command: "set",
  group,
  urls,
});

/** The overflow of a queue that is never full. */
const never = (): never => assert.fail("the queue is not full");

const reading: World = world({
  windows: [{ id: 1, type: "normal", focused: true, tabIds: [1, 3, 2, 4] }],
  tabs: [
    tab(1, 1),
    tab(2, 1, { groupId: 50 }),
    tab(3, 1, { groupId: 50 }),
    tab(4, 1, { groupId: 50, url: `${EMPTY_PAGE}?group=Reading` }),
  ],
  groups: [
    { id: 50, windowId: 1, title: "Reading", color: "blue", collapsed: false },
  ],
  lastFocused: 1,
});

describe("get", () => {
  it("reads the group's tabs in order, without the extension's own pages", async () => {
    assert.deepEqual(
      await handleRequest(servicesOf(fakeChrome(reading)), get()),
      {
        protocol: 1,
        ok: true,
        command: "get",
        group: { title: "Reading", windowId: 1 },
        tabs: [
          { url: "https://example.com/3", title: "Page 3" },
          { url: "https://example.com/2", title: "Page 2" },
        ],
      },
    );
  });

  it("fails with no-group when no group has the title", async () => {
    assert.deepEqual(
      await handleRequest(servicesOf(fakeChrome(reading)), get("reading")),
      failure("no-group", 'no tab group is titled "reading"'),
    );
  });

  it("fails with ambiguous-group when two groups have the title", async () => {
    const twice = {
      ...reading,
      groups: [...reading.groups, { ...reading.groups[0]!, id: 51 }],
      tabs: [...reading.tabs, tab(5, 1, { groupId: 51 })],
      windows: [{ ...reading.windows[0]!, tabIds: [1, 3, 2, 4, 5] }],
    };
    assert.deepEqual(
      await handleRequest(servicesOf(fakeChrome(twice)), get()),
      failure("ambiguous-group", '2 tab groups are titled "Reading"'),
    );
  });

  it("changes nothing", async () => {
    const fake = fakeChrome(reading);
    await handleRequest(servicesOf(fake), get());
    assert.deepEqual(fake.world(), reading);
  });
});

describe("status", () => {
  it("reports the extension's and Chrome's versions", async () => {
    assert.deepEqual(
      await handleRequest(servicesOf(fakeChrome(world())), {
        protocol: 1,
        command: "status",
      }),
      {
        protocol: 1,
        ok: true,
        command: "status",
        extension: "0.1.0",
        chrome: "142.0.1.2",
      },
    );
  });
});

describe("a fault in Chrome", () => {
  it("becomes an internal failure, never a throw", async () => {
    const fake = fakeChrome(reading);
    const services = servicesOf(fake);
    const broken = {
      ...services,
      tabStrip: {
        ...services.tabStrip,
        tabGroups: {
          ...services.tabStrip.tabGroups,
          query: () =>
            Promise.reject(new Error("the browser is shutting down")),
        },
      },
    };
    assert.deepEqual(
      await handleRequest(broken, set(["https://a.example/"])),
      failure(
        "internal",
        "the extension failed to answer: the browser is shutting down",
      ),
    );
  });
});

describe("queueKey", () => {
  it("queues set and get by their group, and status by nothing", () => {
    assert.equal(queueKey(set([])), "Reading");
    assert.equal(queueKey(get("Work")), "Work");
    assert.equal(queueKey({ protocol: 1, command: "status" }), null);
  });
});

describe("one request at a time per group", () => {
  it("runs two sets on one group in arrival order", async () => {
    const fake = fakeChrome(reading);
    const services = servicesOf(fake);
    const enqueue = queueByKey();
    const send = (request: Request): Promise<Response> =>
      enqueue(
        queueKey(request) ?? "",
        () => handleRequest(services, request),
        () => assert.fail("the queue is not full"),
      );
    const [first, second] = await Promise.all([
      send(set(["https://a.example/"])),
      send(set(["https://b.example/"])),
    ]);
    assert.equal(first.ok && first.command === "set" && first.closed, 2);
    // The second found the first's page, so the first had finished.
    assert.equal(second.ok && second.command === "set" && second.closed, 1);
    assert.deepEqual(
      groupTabs(fake.world(), "Reading").map((each) => each.url),
      ["https://b.example/"],
    );
  });

  it("completes requests on two groups side by side", async () => {
    const fake = fakeChrome(reading);
    const services = servicesOf(fake);
    const enqueue = queueByKey();
    const send = (request: Request): Promise<Response> =>
      enqueue(
        queueKey(request) ?? "",
        () => handleRequest(services, request),
        () => assert.fail("the queue is not full"),
      );
    const responses = await Promise.all([
      send(set(["https://a.example/"])),
      send(set(["https://w.example/"], "Work")),
    ]);
    assert.deepEqual(
      responses.map((response) => response.ok),
      [true, true],
    );
    assert.deepEqual(
      groupTabs(fake.world(), "Reading").map((each) => each.url),
      ["https://a.example/"],
    );
    assert.deepEqual(
      groupTabs(fake.world(), "Work").map((each) => each.url),
      ["https://w.example/"],
    );
  });
});

describe("queueByKey", () => {
  const deferred = () => {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };

  it("starts a task only when the one before it under its key settles", async () => {
    const enqueue = queueByKey();
    const gate = deferred();
    const order: string[] = [];
    const first = enqueue(
      "a",
      async () => {
        await gate.promise;
        order.push("first");
        throw new Error("the first fails");
      },
      never,
    );
    const second = enqueue(
      "a",
      async () => {
        order.push("second");
      },
      never,
    );
    const other = enqueue(
      "b",
      async () => {
        order.push("other");
      },
      never,
    );
    await other;
    assert.deepEqual(order, ["other"]);
    gate.resolve();
    await assert.rejects(first);
    await second;
    assert.deepEqual(order, ["other", "first", "second"]);
  });

  it("answers the overflow once the most tasks wait under a key", async () => {
    assert.equal(MAX_WAITING, 100);
    const enqueue = queueByKey(2);
    const gate = deferred();
    const task = (name: string) => async () => {
      await gate.promise;
      return name;
    };
    const full = () => "full";
    const queued = [
      enqueue("a", task("running"), full),
      enqueue("a", task("first waiting"), full),
      enqueue("a", task("second waiting"), full),
      enqueue("a", task("third waiting"), full),
      enqueue("b", task("other key"), full),
    ];
    gate.resolve();
    assert.deepEqual(await Promise.all(queued), [
      "running",
      "first waiting",
      "second waiting",
      "full",
      "other key",
    ]);
    assert.equal(
      await enqueue("a", task("after"), full),
      "after",
      "the queue takes tasks again once it has drained",
    );
  });
});

describe("a request that never finishes", () => {
  it("lets its group's queue move on after 90 seconds", async () => {
    let queries = 0;
    const fake = fakeChrome(reading, {
      hang: (operation) =>
        operation === "tabGroups.query" && (queries += 1) === 1,
    });
    const services = servicesOf(fake);
    const enqueue = queueByKey();
    const send = (request: Request): Promise<Response> =>
      enqueue(
        queueKey(request) ?? "",
        () => handleRequest(services, request),
        never,
      );
    const [first, second] = await Promise.all([
      send(set(["https://a.example/"])),
      send(set(["https://b.example/"])),
    ]);
    assert.deepEqual(
      first,
      failure("internal", "the extension did not answer within 90 seconds"),
    );
    assert.equal(second.ok, true);
    assert.deepEqual(
      groupTabs(fake.world(), "Reading").map((each) => each.url),
      ["https://b.example/"],
    );
  });

  it("calls Chrome no more once a call it was stalled on returns", async () => {
    let creates = 0;
    const fake = fakeChrome(reading, {
      stall: (operation) =>
        operation === "tabs.create" && (creates += 1) === 1 ? 100_000 : 0,
    });
    const services = servicesOf(fake);
    const enqueue = queueByKey();
    const send = (request: Request): Promise<Response> =>
      enqueue(
        queueKey(request) ?? "",
        () => handleRequest(services, request),
        never,
      );
    const [first, second] = await Promise.all([
      send(set(["https://a.example/"])),
      send(set(["https://b.example/"])),
    ]);
    assert.deepEqual(
      first,
      failure("internal", "the extension did not answer within 90 seconds"),
    );
    assert.equal(second.ok, true);
    assert.equal(fake.clock.now(), 90_000, "the stalled call has not returned");
    const made = fake.calls().length;
    // Past the stalled call's return at 100 seconds.
    await fake.clock.sleep(20_000);
    assert.equal(fake.clock.now(), 110_000);
    assert.deepEqual(
      fake.calls().slice(made),
      [],
      "the first run makes no call after its stalled one returns",
    );
    assert.deepEqual(
      groupTabs(fake.world(), "Reading").map((each) => each.url),
      ["https://b.example/"],
    );
    assert.deepEqual(
      fake
        .world()
        .tabs.filter((each) => each.url === "https://a.example/")
        .map((each) => each.groupId),
      [-1],
      "the tab the stalled call opened stays out of the group",
    );
  });
});
