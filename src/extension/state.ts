// What the planner knows of Chrome when a `set` request arrives.

import type { Color } from "../protocol/index.ts";
import type { FormState } from "./form-check.ts";

/** The extension's own pages that can sit in a group. */
export type OwnPage = "status" | "empty";

/**
 * A tab of a group. The caller tells the extension's own pages from the
 * rest; the planner never looks at a URL to decide it. Only the other pages
 * carry the result of the unsubmitted-form check.
 */
export type GroupTab =
  | {
      readonly id: number;
      readonly url: string;
      readonly title: string;
      readonly kind: OwnPage;
    }
  | {
      readonly id: number;
      readonly url: string;
      readonly title: string;
      readonly kind: "other";
      readonly form: FormState;
    };

export type Group = {
  readonly id: number;
  readonly title: string;
  readonly color: Color;
  readonly collapsed: boolean;
  readonly windowId: number;
  /** The group's tabs, in tab-strip order. */
  readonly tabs: readonly GroupTab[];
};

export type GroupState = {
  /**
   * Tab groups that may have the requested title, such as the answer to a
   * title query; only those whose title is exactly the request's count.
   */
  readonly groups: readonly Group[];
  /** The last-focused normal window, which a new group goes in; null when there is none. */
  readonly windowId: number | null;
  /** Whether the group's first tab is the status page, already resolved from the request and the extension's setting. */
  readonly statusPage: boolean;
};
