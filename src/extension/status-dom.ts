// Turns the status page's tree into DOM nodes. Every label goes in as
// text, never as HTML, since titles and URLs come from web pages. A redraw
// keeps the element of each line whose key it already shows, so that only
// a new line slides in and only a changed mark animates.

import type { LineState } from "./progress.ts";
import type { StatusView, ViewNode } from "./view.ts";

/** The members of a DOM element the page uses. */
export type StatusElement = {
  textContent: string | null;
  readonly children: ArrayLike<StatusElement>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  appendChild(node: StatusElement): unknown;
  insertBefore(node: StatusElement, child: StatusElement | null): unknown;
  remove(): void;
};

/** The members of the DOM document the page uses. */
export type StatusDocument = {
  title: string;
  createElement(tag: "li" | "ul" | "span" | "time"): StatusElement;
  getElementById(id: string): StatusElement | null;
};

/** How a line's state reads to a screen reader; the mark shows it to the eye. */
const STATE_TEXT: { readonly [S in LineState]: string } = {
  waiting: "Waiting:",
  running: "Under way:",
  done: "Done:",
  kept: "Kept:",
  unchecked: "Not checked:",
  failed: "Failed:",
};

/** A line's parts, by their place among its element's children after the mark. */
const STATE = 1;
const LABEL = 2;
const TIME = 3;
const LIST = 4;

const part = (item: StatusElement, index: number): StatusElement => {
  const child = item.children[index];
  if (child === undefined) {
    throw new Error(`a line has no part ${index}`);
  }
  return child;
};

const withClass = (
  doc: StatusDocument,
  tag: "span" | "time" | "ul",
  name: string,
): StatusElement => {
  const element = doc.createElement(tag);
  element.setAttribute("class", name);
  return element;
};

const newLine = (doc: StatusDocument, key: string): StatusElement => {
  const item = doc.createElement("li");
  item.setAttribute("data-key", key);
  const mark = withClass(doc, "span", "mark");
  mark.setAttribute("aria-hidden", "true");
  [
    mark,
    withClass(doc, "span", "state"),
    withClass(doc, "span", "label"),
    withClass(doc, "time", "time"),
    withClass(doc, "ul", "lines"),
  ].forEach((child) => item.appendChild(child));
  return item;
};

const setText = (element: StatusElement, text: string): void => {
  if (element.textContent !== text) {
    element.textContent = text;
  }
};

const fill = (
  doc: StatusDocument,
  item: StatusElement,
  node: ViewNode,
  formatTime: (time: number) => string,
): void => {
  if (node.state === null) {
    item.removeAttribute("data-state");
  } else if (item.getAttribute("data-state") !== node.state) {
    item.setAttribute("data-state", node.state);
  }
  setText(part(item, STATE), node.state === null ? "" : STATE_TEXT[node.state]);
  setText(part(item, LABEL), node.label);
  const time = part(item, TIME);
  if (node.time === undefined) {
    time.removeAttribute("datetime");
    setText(time, "");
  } else {
    time.setAttribute("datetime", new Date(node.time).toISOString());
    setText(time, formatTime(node.time));
  }
  drawLines(doc, part(item, LIST), node.children, formatTime);
};

/** Makes `list` show `nodes`, in order, reusing the element of each key it shows. */
export const drawLines = (
  doc: StatusDocument,
  list: StatusElement,
  nodes: readonly ViewNode[],
  formatTime: (time: number) => string,
): void => {
  const existing = Array.from(list.children);
  nodes.forEach((node, index) => {
    const item =
      existing.find((each) => each.getAttribute("data-key") === node.key) ??
      newLine(doc, node.key);
    fill(doc, item, node, formatTime);
    const at = list.children[index] ?? null;
    if (at !== item) {
      list.insertBefore(item, at);
    }
  });
  Array.from(list.children)
    .slice(nodes.length)
    .forEach((extra) => extra.remove());
};

/** Draws the view into the page: its title, heading and the list `#status`. */
export const drawStatus = (
  doc: StatusDocument,
  status: StatusView,
  formatTime: (time: number) => string,
): void => {
  doc.title = status.title;
  const heading = doc.getElementById("group");
  if (heading !== null) {
    setText(heading, status.heading);
  }
  const list = doc.getElementById("status");
  if (list !== null) {
    drawLines(doc, list, status.sections, formatTime);
  }
};
