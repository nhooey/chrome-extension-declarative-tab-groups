// Where each group's progress lives between the service worker, which
// writes it, and the group's status page, which reads it: one item of
// `chrome.storage.session` per group, reached through `ProgressStorage`,
// a narrowed interface naming the two storage calls used. A report is the
// function the edge calls with each event; it never holds up or fails the
// request, whether the storage refuses or never answers.
//
// The report's progress is the module's only state, held as queue.ts holds
// its queues: one entry of a `Map` in the report's closure, never a
// reassigned variable.

import {
  advance,
  idle,
  type Outcome,
  type Progress,
  type ProgressEvent,
} from "./progress.ts";

/** The members of `chrome.storage.session` the extension uses; `get(null)` reads every item. */
export type ProgressStorage = {
  readonly get: (
    key: string | null,
  ) => Promise<{ readonly [key: string]: unknown }>;
  readonly set: (items: { [key: string]: Progress }) => Promise<void>;
};

/** Reports one event of a request, returning at once; what it writes is written later, or never. */
export type Report = (event: ProgressEvent) => void;

/** The report of a caller that shows no progress. */
export const ignoreProgress: Report = () => undefined;

/** The storage key of the group titled `title`. */
export const progressKey = (title: string): string => `progress:${title}`;

const isProgress = (value: unknown, title: string): value is Progress =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly group?: unknown }).group === title;

/** The stored progress of the group titled `title`, or an idle one. */
export const readProgress = async (
  storage: Pick<ProgressStorage, "get">,
  title: string,
): Promise<Progress> => {
  try {
    const value = (await storage.get(progressKey(title)))[progressKey(title)];
    return isProgress(value, title) ? value : idle(title);
  } catch {
    return idle(title);
  }
};

/**
 * A report for one request on the group titled `title`: each event is
 * folded, in the order reported, into the group's progress as first read,
 * which is then written. Requests on a group run one at a time, so the
 * progress read here is not changed by anything else while the request
 * runs. Once the request's end is reported, later events are ignored: a
 * request answered at its deadline may still be running, and must not
 * write over the next request's progress.
 */
export const progressReport = (
  storage: ProgressStorage,
  title: string,
): Report => {
  // The progress folded so far, until the request's end removes it.
  const folded = new Map([[title, readProgress(storage, title)]]);
  return (event) => {
    const previous = folded.get(title);
    if (previous === undefined) {
      return;
    }
    const next = previous.then((progress) => advance(progress, event));
    if (event.kind === "request-finished") {
      folded.delete(title);
    } else {
      folded.set(title, next);
    }
    void next
      .then((progress) => storage.set({ [progressKey(title)]: progress }))
      .catch(() => {
        // The status page then shows an older step; the request goes on.
      });
  };
};

/** How a request ends that a service worker since stopped left under way. */
export const INTERRUPTED: Outcome = {
  ok: false,
  code: "internal",
  message: "the service worker stopped before the request finished",
};

/**
 * The items to store when the service worker starts, from every stored
 * item: each group's progress whose request is still under way, which no
 * worker will now finish, with that request ended as `INTERRUPTED` at
 * `at`. Any other item, and a progress with no request under way, is left
 * out, so nothing is written for it.
 */
export const interruptedProgress = (
  stored: { readonly [key: string]: unknown },
  at: number,
): { [key: string]: Progress } =>
  Object.fromEntries(
    Object.entries(stored).flatMap(([key, value]) => {
      const title =
        typeof value === "object" && value !== null
          ? (value as { readonly group?: unknown }).group
          : undefined;
      return typeof title === "string" &&
        key === progressKey(title) &&
        isProgress(value, title) &&
        value.current !== null
        ? [
            [
              key,
              advance(value, {
                kind: "request-finished",
                at,
                outcome: INTERRUPTED,
              }),
            ],
          ]
        : [];
    }),
  );

/**
 * Ends, in the storage, every request a stopped service worker left under
 * way. It never rejects, and writes nothing once `signal` aborts, since a
 * request may by then be writing its own progress.
 */
export const endInterrupted = async (
  storage: ProgressStorage,
  at: number,
  signal: AbortSignal,
): Promise<void> => {
  try {
    const ended = interruptedProgress(await storage.get(null), at);
    if (Object.keys(ended).length > 0 && !signal.aborted) {
      await storage.set(ended);
    }
  } catch {
    // Each group's page then shows its request under way until the next.
  }
};
