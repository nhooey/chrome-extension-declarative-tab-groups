// A seeded generator of group states and `set` requests, so that a failing
// case can be found again by its seed.

import { COLORS, type SetRequest } from "../../src/protocol/index.ts";
import type { FormState } from "../../src/extension/form-check.ts";
import type { Group, GroupState, GroupTab } from "../../src/extension/state.ts";

/** Mulberry32: a small pseudo-random generator, from a 32-bit seed. */
const mulberry32 = (seed: number): (() => number) => {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

type Random = {
  readonly below: (n: number) => number;
  readonly chance: (p: number) => boolean;
  readonly pick: <T>(items: readonly T[]) => T;
};

const random = (seed: number): Random => {
  const next = mulberry32(seed);
  const below = (n: number): number => Math.floor(next() * n);
  return {
    below,
    chance: (p) => next() < p,
    pick: <T>(items: readonly T[]): T => {
      const item = items[below(items.length)];
      if (item === undefined) {
        throw new Error("pick from an empty list");
      }
      return item;
    },
  };
};

/** A few URLs, so that existing tabs often show a URL the request names. */
const URLS = [
  "https://example.com/",
  "https://example.com/a",
  "https://example.org/compose",
  "file:///tmp/notes.html",
  "https://example.net/",
] as const;

const FORMS: readonly FormState[] = ["clean", "unsubmitted", "unchecked"];

export const TITLE = "Reading";

/** Titles that are close to the requested one but do not match it. */
const OTHER_TITLES = ["reading", "Reading ", "Writing"] as const;

export type Case = {
  readonly seed: number;
  readonly state: GroupState;
  readonly request: SetRequest;
};

const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

/**
 * One case: zero, one or two groups with the requested title among decoys,
 * each of one to seven tabs of every kind and form state, frozen so that a
 * planner that mutates its input throws.
 */
export const generate = (seed: number, statusPage: boolean): Case => {
  const r = random(seed);
  let nextId = 1;

  const tab = (): GroupTab => {
    const id = nextId++;
    const url = r.pick(URLS);
    const roll = r.below(10);
    return roll < 1
      ? {
          id,
          url: "chrome-extension://x/status.html",
          title: "Status",
          kind: "status",
        }
      : roll < 2
        ? {
            id,
            url: "chrome-extension://x/empty.html",
            title: "Empty",
            kind: "empty",
          }
        : { id, url, title: `Page ${id}`, kind: "other", form: r.pick(FORMS) };
  };

  const group = (title: string): Group => ({
    id: nextId++,
    title,
    color: r.pick(COLORS),
    collapsed: r.chance(0.3),
    windowId: 100 + r.below(3),
    tabs: Array.from({ length: 1 + r.below(7) }, tab),
  });

  const matching = r.pick([0, 1, 1, 1, 1, 1, 2]);
  const groups = [
    ...Array.from({ length: matching }, () => group(TITLE)),
    ...Array.from({ length: r.below(3) }, () => group(r.pick(OTHER_TITLES))),
  ];
  const urls = Array.from({ length: r.below(5) }, () => r.pick(URLS));
  const color = r.chance(0.5) ? r.pick(COLORS) : undefined;
  const windowRoll = r.below(3);
  const createWindow = windowRoll === 0 ? undefined : windowRoll === 1;
  const request: SetRequest = {
    protocol: 1,
    command: "set",
    group: TITLE,
    urls,
    ...(color === undefined ? {} : { color }),
    ...(createWindow === undefined ? {} : { createWindow }),
  };
  return deepFreeze({
    seed,
    state: {
      groups,
      windowId: r.chance(0.8) ? 100 + r.below(3) : null,
      statusPage,
    },
    request,
  });
};
