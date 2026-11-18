// The steps a plan is made of: plain data that the extension carries out
// in order. No step focuses or raises a window: every tab opens inactive
// and a created window opens unfocused, and no kind exists that could do
// otherwise. One kind makes a tab active, and only the status page, in
// place of a tab the plan closes while it is its window's active tab.

import type { Color } from "../protocol/index.ts";

/**
 * A tab this plan opens, named by its role and position since it has no id
 * when the plan is made: the status page, the empty page, or the page of
 * `urls[index]`.
 */
export type NewTab =
  | { readonly role: "status" }
  | { readonly role: "empty" }
  | { readonly role: "url"; readonly index: number; readonly url: string };

/** Every kind of step, in no particular order; a test pins this list. */
export const STEP_KINDS = [
  "create-window",
  "open-in-window",
  "create-group",
  "open-in-group",
  "move-first",
  "activate-status-page",
  "close",
  "set-color",
  "collapse",
  "wait-for-load",
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/**
 * One step. Each acts on the plan's group: the existing one, or the one its
 * `create-group` step makes.
 */
export type Step =
  /** Opens a new normal window, not focused, holding `tab`. */
  | { readonly kind: "create-window"; readonly tab: NewTab }
  /** Opens `tab`, inactive, at the end of the window's tab strip. */
  | {
      readonly kind: "open-in-window";
      readonly windowId: number;
      readonly tab: NewTab;
    }
  /** Makes the plan's group from `tab`, with this title and colour. */
  | {
      readonly kind: "create-group";
      readonly tab: NewTab;
      readonly title: string;
      readonly color?: Color;
    }
  /** Opens `tab`, inactive, as the group's first or last tab. */
  | {
      readonly kind: "open-in-group";
      readonly tab: NewTab;
      readonly at: "start" | "end";
    }
  /** Moves an existing tab of the group to the group's first place. */
  | { readonly kind: "move-first"; readonly tabId: number }
  /**
   * Makes the group's status page its window's active tab, in place of
   * `replacing`, the window's active tab, which a later step closes; it
   * does nothing when `replacing` is no longer the active tab by then.
   * `tabId` is the status page's id, or null for the one this plan opens.
   */
  | {
      readonly kind: "activate-status-page";
      readonly tabId: number | null;
      readonly replacing: number;
    }
  /** Closes existing tabs of the group. */
  | { readonly kind: "close"; readonly tabIds: readonly number[] }
  | { readonly kind: "set-color"; readonly color: Color }
  | { readonly kind: "collapse" }
  /** Waits until the tabs have loaded, or `timeoutMs` has passed. */
  | {
      readonly kind: "wait-for-load";
      readonly tabs: readonly NewTab[];
      readonly timeoutMs: number;
    };

/** How long a plan waits for its opened tabs to load. */
export const LOAD_TIMEOUT_MS = 30_000;
