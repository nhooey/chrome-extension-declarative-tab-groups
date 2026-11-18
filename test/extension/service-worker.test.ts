// The service worker's edge against a fake runtime: it does nothing
// outside Google Chrome, and in Chrome it connects, answers requests on
// the port, and reconnects from the alarm.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Brand } from "../../src/extension/browser.ts";
import {
  RECONNECT_ALARM,
  RECONNECT_PERIOD_MINUTES,
} from "../../src/extension/connection.ts";
import { NATIVE_HOST_NAME } from "../../src/extension/identity.ts";
import {
  type NativePort,
  startServiceWorker,
  type WorkerRuntime,
} from "../../src/extension/service-worker.ts";
import type { ResponseEnvelope } from "../../src/protocol/index.ts";
import { BRANDS } from "./brands.ts";
import { fakeChrome, servicesOf, world } from "./fake-chrome.ts";

type FakePort = NativePort & {
  readonly posted: ResponseEnvelope[];
  readonly receive: (message: unknown) => void;
  readonly close: () => void;
  readonly closedByWorker: () => boolean;
};

const fakePort = (): FakePort => {
  const posted: ResponseEnvelope[] = [];
  const onMessage: ((message: unknown) => void)[] = [];
  const onDisconnect: (() => void)[] = [];
  let closed = false;
  return {
    posted,
    postMessage: (message) => {
      posted.push(message);
    },
    disconnect: () => {
      closed = true;
    },
    onMessage: { addListener: (listener) => onMessage.push(listener) },
    onDisconnect: { addListener: (listener) => onDisconnect.push(listener) },
    receive: (message) => onMessage.forEach((listener) => listener(message)),
    close: () => onDisconnect.forEach((listener) => listener()),
    closedByWorker: () => closed,
  };
};

type Recorder = {
  readonly runtime: WorkerRuntime;
  readonly ports: FakePort[];
  readonly alarms: string[];
  readonly listeners: string[];
  readonly fire: (event: "startup" | "installed" | "alarm") => void;
};

const fakeRuntime = (brands: readonly Brand[] | undefined): Recorder => {
  const ports: FakePort[] = [];
  const alarms: string[] = [];
  const listeners: string[] = [];
  const handlers: { [event: string]: (() => void)[] } = {};
  const listen = (event: string) => ({
    addListener: (listener: () => void) => {
      listeners.push(event);
      handlers[event] = [...(handlers[event] ?? []), listener];
    },
  });
  return {
    ports,
    alarms,
    listeners,
    fire: (event) => (handlers[event] ?? []).forEach((listener) => listener()),
    runtime: {
      brands,
      connectNative: (application) => {
        assert.equal(application, NATIVE_HOST_NAME);
        const port = fakePort();
        ports.push(port);
        return port;
      },
      lastError: () => null,
      onStartup: listen("startup"),
      onInstalled: listen("installed"),
      alarms: {
        create: (name, info) => {
          assert.equal(info.periodInMinutes, RECONNECT_PERIOD_MINUTES);
          alarms.push(`create ${name}`);
          return Promise.resolve();
        },
        clear: (name) => {
          alarms.push(`clear ${name}`);
          return Promise.resolve(true);
        },
        onAlarm: {
          addListener: (listener) =>
            listen("alarm").addListener(() =>
              listener({ name: RECONNECT_ALARM }),
            ),
        },
      },
      log: () => undefined,
      services: servicesOf(fakeChrome(world())),
    },
  };
};

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("the service worker outside Google Chrome", () => {
  for (const [name, brands] of [
    ["Brave", BRANDS.brave],
    ["Microsoft Edge", BRANDS.edge],
    ["Chromium", BRANDS.chromium],
    ["a browser without userAgentData", undefined],
  ] as const) {
    it(`does nothing at all in ${name}`, () => {
      const recorder = fakeRuntime(brands);
      assert.equal(startServiceWorker(recorder.runtime), false);
      assert.deepEqual(recorder.ports, []);
      assert.deepEqual(recorder.listeners, []);
      assert.deepEqual(recorder.alarms, []);
    });
  }
});

describe("the service worker in Google Chrome", () => {
  it("connects at start and answers a request under its id", async () => {
    const recorder = fakeRuntime(BRANDS.chrome);
    assert.equal(startServiceWorker(recorder.runtime), true);
    assert.deepEqual(recorder.listeners, ["startup", "installed", "alarm"]);
    const [port] = recorder.ports;
    assert.ok(port !== undefined);
    port.receive({ hello: { protocol: 1 } });
    port.receive({ id: "1", request: { protocol: 1, command: "status" } });
    await settle();
    assert.deepEqual(port.posted, [
      {
        id: "1",
        response: {
          protocol: 1,
          ok: true,
          command: "status",
          extension: "0.1.0",
          chrome: "142.0.1.2",
        },
      },
    ]);
    recorder.fire("startup");
    assert.equal(recorder.ports.length, 1, "a second start does not reconnect");
  });

  it("drops a port whose host sends no hello, and retries from the alarm", async () => {
    const recorder = fakeRuntime(BRANDS.chrome);
    startServiceWorker(recorder.runtime);
    const [port] = recorder.ports;
    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(port?.closedByWorker(), true);
    assert.deepEqual(recorder.alarms, [`create ${RECONNECT_ALARM}`]);
    recorder.fire("alarm");
    assert.equal(recorder.ports.length, 2);
  });

  it("reconnects from the alarm after the port closes", () => {
    const recorder = fakeRuntime(BRANDS.chrome);
    startServiceWorker(recorder.runtime);
    recorder.ports[0]?.close();
    assert.deepEqual(recorder.alarms, [`create ${RECONNECT_ALARM}`]);
    recorder.fire("alarm");
    assert.equal(recorder.ports.length, 2);
    recorder.ports[1]?.receive({ hello: { protocol: 1 } });
    assert.deepEqual(recorder.alarms, [
      `create ${RECONNECT_ALARM}`,
      `clear ${RECONNECT_ALARM}`,
    ]);
  });

  it("stops for good when the host refuses this browser", () => {
    const recorder = fakeRuntime(BRANDS.chrome);
    startServiceWorker(recorder.runtime);
    const [port] = recorder.ports;
    port?.receive({ hello: { refused: "not-google-chrome" } });
    assert.equal(port?.closedByWorker(), true);
    port?.close();
    recorder.fire("alarm");
    recorder.fire("startup");
    assert.equal(recorder.ports.length, 1);
    // A stray alarm is cleared again; none is ever set.
    assert.deepEqual(recorder.alarms, [
      `clear ${RECONNECT_ALARM}`,
      `clear ${RECONNECT_ALARM}`,
    ]);
  });

  it("ignores a port it has already let go of", () => {
    const recorder = fakeRuntime(BRANDS.chrome);
    startServiceWorker(recorder.runtime);
    const [first] = recorder.ports;
    first?.receive({ hello: { refused: "socket-in-use" } });
    recorder.fire("alarm");
    const second = recorder.ports[1];
    second?.receive({ hello: { protocol: 1 } });
    first?.close();
    first?.receive({ id: "2", request: { protocol: 1, command: "status" } });
    assert.equal(recorder.ports.length, 2);
    assert.deepEqual(first?.posted, []);
    assert.deepEqual(recorder.alarms, [
      `create ${RECONNECT_ALARM}`,
      `clear ${RECONNECT_ALARM}`,
    ]);
  });
});
