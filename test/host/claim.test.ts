// The socket's claim, run by several hosts at once on a model of the file
// system. Each step of `SocketEdge` waits for a scheduler, which runs every
// interleaving of the hosts' steps, or a seeded sample of them, and checks
// after each step that at most one host serves, that it holds the socket,
// and that no host removed another live host's claim or socket.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  claimSocket,
  mayServe,
  type Probe,
  releaseSocket,
  type SocketEdge,
  socketStep,
} from "../../src/host/claim.ts";

type Entry = { readonly owner: string; readonly live: boolean };

/** The model: the claims and the socket at their paths, and who serves. */
type World = {
  readonly claims: Map<string, Entry>;
  socket: Entry | "file" | null;
  readonly serving: Set<string>;
  readonly violations: string[];
};

const claimOf = (host: string): string => `claim-${host}`;

/** The model's edge for one host: each step waits at `gate`, then happens at once. */
const modelEdge = (
  world: World,
  host: string,
  gate: () => Promise<void>,
): SocketEdge => {
  const step =
    <A extends unknown[], R>(body: (...args: A) => R) =>
    async (...args: A): Promise<R> => {
      await gate();
      return body(...args);
    };
  const probeOf = (entry: Entry | undefined | "file" | null): Probe =>
    entry === undefined || entry === null
      ? "gone"
      : entry === "file" || entry.live
        ? "answered"
        : "refused";
  return {
    createClaim: step(() => {
      world.claims.set(claimOf(host), { owner: host, live: true });
      return claimOf(host);
    }),
    listClaims: step(() => [...world.claims.keys()]),
    probeClaim: step((name: string) => probeOf(world.claims.get(name))),
    removeClaim: step((name: string) => {
      const entry = world.claims.get(name);
      if (entry?.live === true) {
        world.violations.push(`${host} removed ${entry.owner}'s live claim`);
      }
      world.claims.delete(name);
    }),
    closeClaim: step(() => {
      world.claims.delete(claimOf(host));
    }),
    inspectSocket: step(() =>
      world.socket === null
        ? "absent"
        : world.socket === "file"
          ? "other"
          : "socket",
    ),
    probeSocket: step(() => probeOf(world.socket)),
    removeSocket: step(() => {
      if (typeof world.socket === "object" && world.socket?.live === true) {
        world.violations.push(
          `${host} removed ${world.socket.owner}'s live socket`,
        );
      }
      world.socket = null;
    }),
    bindSocket: step(() => {
      if (world.socket !== null) {
        return { kind: "in-use" as const };
      }
      world.socket = { owner: host, live: true };
      return { kind: "bound" as const };
    }),
    // Two steps, as the model takes no order inside Node for granted: the
    // socket stops listening, then Node removes the path, whoever's socket
    // is there by then.
    closeSocket: async () => {
      await gate();
      if (
        typeof world.socket === "object" &&
        world.socket !== null &&
        world.socket.owner === host
      ) {
        world.socket = { owner: host, live: false };
      }
      await gate();
      if (
        typeof world.socket === "object" &&
        world.socket !== null &&
        world.socket.owner !== host
      ) {
        world.violations.push(
          `${host} closing removed ${world.socket.owner}'s socket`,
        );
      }
      world.socket = null;
    },
  };
};

/** A host that claims the socket, and serves on, or stops once it has served. */
const starting =
  (stops: boolean) =>
  async (world: World, host: string, edge: SocketEdge): Promise<string> => {
    const outcome = await claimSocket(edge);
    if (outcome.kind === "bound") {
      world.serving.add(host);
      if (stops) {
        world.serving.delete(host);
        await releaseSocket(edge);
      }
    }
    return outcome.kind;
  };

/** A host that already serves, and stops. */
const stopping = async (
  world: World,
  host: string,
  edge: SocketEdge,
): Promise<string> => {
  world.serving.delete(host);
  await releaseSocket(edge);
  return "stopped";
};

type Program = (
  world: World,
  host: string,
  edge: SocketEdge,
) => Promise<string>;

type Scenario = {
  readonly world: World;
  readonly hosts: readonly (readonly [string, Program])[];
};

const invariantBroken = (world: World): string | null => {
  if (world.serving.size > 1) {
    return `${[...world.serving].join(" and ")} serve at once`;
  }
  const [server] = world.serving;
  return server !== undefined &&
    (typeof world.socket !== "object" || world.socket?.owner !== server)
    ? `${server} serves without its socket`
    : null;
};

type Run = {
  readonly trace: readonly string[];
  readonly choices: readonly (readonly string[])[];
  readonly outcomes: ReadonlyMap<string, string>;
};

/** Runs the scenario's hosts, letting `choose` pick whose step comes next. */
const runSchedule = async (
  scenario: Scenario,
  choose: (index: number, pending: readonly string[]) => string,
): Promise<Run> => {
  const { world, hosts } = scenario;
  const waiting = new Map<string, () => void>();
  const outcomes = new Map<string, string>();
  let changed: (() => void) | null = null;
  hosts.forEach(([host, program]) => {
    const gate = (): Promise<void> =>
      new Promise((resolve) => {
        waiting.set(host, resolve);
        changed?.();
      });
    void program(world, host, modelEdge(world, host, gate)).then((outcome) => {
      outcomes.set(host, outcome);
      changed?.();
    });
  });
  /** Waits until every host waits at a step or has finished. */
  const settled = (): Promise<void> =>
    new Promise((resolve) => {
      const check = (): void => {
        if (hosts.every(([host]) => waiting.has(host) || outcomes.has(host))) {
          changed = null;
          resolve();
        } else {
          changed = check;
        }
      };
      check();
    });
  const trace: string[] = [];
  const choices: (readonly string[])[] = [];
  await settled();
  while (waiting.size > 0) {
    const pending = [...waiting.keys()].toSorted();
    const host = choose(trace.length, pending);
    trace.push(host);
    choices.push(pending);
    const release = waiting.get(host);
    waiting.delete(host);
    release?.();
    await settled();
    const broken = invariantBroken(world);
    if (broken !== null) {
      world.violations.push(`after ${trace.join(" ")}: ${broken}`);
    }
  }
  return { trace, choices, outcomes };
};

/**
 * Runs every interleaving of the scenario's steps once: each run replays a
 * prefix, then takes the first pending host, and every other choice it
 * passes becomes a prefix still to run.
 */
const everyInterleaving = async (
  scenario: () => Scenario,
  check: (world: World, run: Run) => void,
): Promise<number> => {
  const prefixes: (readonly string[])[] = [[]];
  let runs = 0;
  while (prefixes.length > 0) {
    const prefix = prefixes.pop() ?? [];
    const fresh = scenario();
    const run = await runSchedule(fresh, (index, pending) =>
      index < prefix.length ? (prefix[index] ?? "") : (pending[0] ?? ""),
    );
    runs += 1;
    check(fresh.world, run);
    for (let index = prefix.length; index < run.trace.length; index += 1) {
      (run.choices[index] ?? [])
        .filter((host) => host !== run.trace[index])
        .forEach((host) => prefixes.push([...run.trace.slice(0, index), host]));
    }
  }
  return runs;
};

const world = (
  claims: readonly (readonly [string, Entry])[],
  socket: World["socket"],
  serving: readonly string[] = [],
): World => ({
  claims: new Map(claims),
  socket,
  serving: new Set(serving),
  violations: [],
});

const DEAD = { owner: "gone", live: false };

const servedByAtMostOne = (state: World, run: Run): void => {
  assert.deepEqual(state.violations, [], run.trace.join(" "));
  const bound = [...run.outcomes].filter(([, outcome]) => outcome === "bound");
  assert.ok(bound.length <= 1, run.trace.join(" "));
};

describe("the socket's claim: pure decisions", () => {
  it("serves only when no other claim answers", () => {
    assert.equal(mayServe([]), true);
    assert.equal(mayServe(["refused", "gone"]), true);
    assert.equal(mayServe(["refused", "answered"]), false);
  });

  it("binds a free path, replaces a stale socket, and leaves the rest alone", () => {
    assert.equal(socketStep("absent", null), "bind");
    assert.equal(socketStep("socket", "refused"), "remove-then-bind");
    assert.equal(socketStep("socket", "gone"), "bind");
    assert.equal(socketStep("socket", "answered"), "in-use");
    assert.equal(socketStep("other", null), "not-a-socket");
  });
});

describe("the socket's claim: hosts interleaved", () => {
  it("lets the first of two hosts serve, removing a dead host's claim and socket", async () => {
    const scenario: Scenario = {
      world: world([["claim-gone", DEAD]], DEAD),
      hosts: [
        ["a", starting(false)],
        ["b", starting(false)],
      ],
    };
    const run = await runSchedule(scenario, (index, pending) =>
      pending.includes("a") ? "a" : (pending[0] ?? ""),
    );
    assert.deepEqual([...run.outcomes].toSorted(), [
      ["a", "bound"],
      ["b", "in-use"],
    ]);
    assert.deepEqual([...scenario.world.claims.keys()], ["claim-a"]);
    assert.deepEqual(scenario.world.socket, { owner: "a", live: true });
  });

  it("never lets two hosts started together both serve, nor remove a live file, in any order", async () => {
    const runs = await everyInterleaving(
      () => ({
        world: world([["claim-gone", DEAD]], DEAD),
        hosts: [
          ["a", starting(false)],
          ["b", starting(false)],
        ],
      }),
      servedByAtMostOne,
    );
    assert.ok(runs > 1000, `${runs} interleavings`);
  });

  it("never lets a stopping host remove the socket of one starting, in any order", async () => {
    const runs = await everyInterleaving(
      () => ({
        world: world(
          [["claim-a", { owner: "a", live: true }]],
          { owner: "a", live: true },
          ["a"],
        ),
        hosts: [
          ["a", stopping],
          ["b", starting(false)],
        ],
      }),
      servedByAtMostOne,
    );
    assert.ok(runs > 10, `${runs} interleavings`);
  });

  it("keeps a host that starts and stops from troubling a second one, in any order", async () => {
    // Both may serve, one after the other; the check after every step
    // finds two serving at once.
    await everyInterleaving(
      () => ({
        world: world([], null),
        hosts: [
          ["a", starting(true)],
          ["b", starting(false)],
        ],
      }),
      (state, run) =>
        assert.deepEqual(state.violations, [], run.trace.join(" ")),
    );
  });

  it("never lets three hosts started together both serve, in a seeded sample of orders", async () => {
    // A linear congruential generator, so a failure names a repeatable seed.
    const random = (seed: number) => {
      let state = seed;
      return (): number => {
        state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
        return state / 2 ** 31;
      };
    };
    for (let seed = 1; seed <= 2_000; seed += 1) {
      const next = random(seed);
      const scenario: Scenario = {
        world: world([["claim-gone", DEAD]], DEAD),
        hosts: [
          ["a", starting(false)],
          ["b", starting(true)],
          ["c", starting(false)],
        ],
      };
      const run = await runSchedule(
        scenario,
        (_, pending) => pending[Math.floor(next() * pending.length)] ?? "",
      );
      assert.deepEqual(scenario.world.violations, [], `seed ${seed}`);
      assert.ok(
        [...run.outcomes.values()].filter((outcome) => outcome === "bound")
          .length <= 2,
        `seed ${seed}`,
      );
    }
  });
});
