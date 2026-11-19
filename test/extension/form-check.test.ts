// The form check runs against a fake of the few DOM members it reads. It
// runs from its own source text, in a fresh `node:vm` context whose global
// is the fake window and with no argument, as Chrome runs it in a frame; a
// reference to anything outside the function's body fails there.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

import {
  type FormControl,
  hasUnsubmittedForm,
  type InputControl,
  type Probe,
  type QueryRoot,
  type SelectControl,
  type SelectOption,
  type ShadowHost,
  type TextAreaControl,
  tabFormState,
  type UnloadEvent,
} from "../../src/extension/form-check.ts";

const USER_SELECTORS = ":user-valid, :user-invalid";

type Look = {
  readonly disabled?: boolean;
  readonly rendered?: boolean;
  /** Whether the user has interacted with the control. */
  readonly interacted?: boolean;
  /** Whether the browser lacks `:user-valid` and `:user-invalid`. */
  readonly oldBrowser?: boolean;
};

const element = ({
  disabled = false,
  rendered = true,
  interacted = false,
  oldBrowser = false,
}: Look) => ({
  matches: (selectors: string): boolean => {
    if (selectors === ":disabled") {
      return disabled;
    }
    assert.equal(selectors, USER_SELECTORS);
    if (oldBrowser) {
      throw new SyntaxError(`'${selectors}' is not a valid selector`);
    }
    return interacted;
  },
  checkVisibility: (): boolean => rendered,
});

const input = (
  fields: Partial<Omit<InputControl, "localName">> & Look = {},
): InputControl => ({
  type: "text",
  multiple: false,
  readOnly: false,
  value: "",
  defaultValue: "",
  checked: false,
  defaultChecked: false,
  files: null,
  ...fields,
  ...element(fields),
  localName: "input",
});

const textarea = (
  fields: Partial<Omit<TextAreaControl, "localName">> & Look = {},
): TextAreaControl => ({
  readOnly: false,
  value: "",
  defaultValue: "",
  ...fields,
  ...element(fields),
  localName: "textarea",
});

const option = (
  selected: boolean,
  defaultSelected: boolean,
  disabled = false,
): SelectOption => ({
  selected,
  defaultSelected,
  matches: (selectors) => selectors === ":disabled" && disabled,
});

const select = (
  options: readonly SelectOption[],
  fields: Partial<Pick<SelectControl, "multiple" | "size">> & Look = {},
): SelectControl => ({
  multiple: false,
  size: 0,
  options,
  selectedIndex: options.findIndex((each) => each.selected),
  ...fields,
  ...element(fields),
  localName: "select",
});

const VALID_NUMBER = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/;
const LOCAL_DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

/**
 * The browser's value sanitisation, for the types these tests use: what a
 * detached control of `localName` and `type` reads back after `value` is set.
 */
const sanitise = (
  localName: "input" | "textarea",
  type: string,
  multiple: boolean,
  value: string,
): string => {
  if (localName === "textarea") {
    return value.replace(/\r\n?/g, "\n");
  }
  const noNewlines = value.replace(/[\r\n]/g, "");
  switch (type) {
    case "number":
      return VALID_NUMBER.test(value) ? value : "";
    case "email":
      return multiple
        ? noNewlines
            .split(",")
            .map((each) => each.trim())
            .join(",")
        : noNewlines.trim();
    case "url":
      return noNewlines.trim();
    case "datetime-local": {
      const parts = LOCAL_DATE_TIME.exec(value);
      if (parts === null) {
        return "";
      }
      const [, date, minutes, seconds = "00", fraction = ""] = parts;
      const tail = fraction.replace(/0+$/, "");
      return seconds === "00" && tail === ""
        ? `${date}T${minutes}`
        : `${date}T${minutes}:${seconds}${tail === "" ? "" : `.${tail}`}`;
    }
    default:
      return noNewlines;
  }
};

const probe = (localName: "input" | "textarea"): Probe => {
  let raw = "";
  return {
    type: "text",
    multiple: false,
    get value(): string {
      return sanitise(localName, this.type, this.multiple, raw);
    },
    set value(value: string) {
      raw = value;
    },
  };
};

/** A document or shadow root holding `controls`, and `hosts` among its elements. */
const root = (
  controls: readonly FormControl[],
  hosts: readonly ShadowHost[] = [],
): QueryRoot => ({
  querySelectorAll: ((selectors: string) => {
    if (selectors === "*") {
      return [{ shadowRoot: null }, ...hosts];
    }
    assert.equal(selectors, "input, textarea, select");
    return controls;
  }) as QueryRoot["querySelectorAll"],
});

/** What a page's `beforeunload` listeners do to the event. */
type Listener = (event: {
  preventDefault(): void;
  returnValue: unknown;
}) => void;

type Page = {
  readonly hosts?: readonly ShadowHost[];
  readonly listener?: Listener;
  /** The frame's sticky user activation; `absent` leaves `navigator.userActivation` out. */
  readonly active?: boolean | "absent";
};

/**
 * A window holding `controls`. Its `dispatchEvent` runs `listener` on the
 * event and records the dispatch, so a test can tell whether it ran.
 */
const fakeWindow = (
  controls: readonly FormControl[],
  { hosts = [], listener = () => {}, active = true }: Page,
) => {
  const dispatched: string[] = [];
  const window = {
    document: {
      ...root(controls, hosts),
      createElement: probe,
      createEvent: (kind: string): UnloadEvent => {
        assert.equal(kind, "BeforeUnloadEvent");
        const event = {
          type: "",
          cancelable: false,
          defaultPrevented: false,
          returnValue: "" as unknown,
          initEvent(type: string, bubbles: boolean, cancelable: boolean) {
            assert.equal(bubbles, false);
            this.type = type;
            this.cancelable = cancelable;
          },
          preventDefault() {
            this.defaultPrevented = this.cancelable;
          },
        };
        return event;
      },
    },
    navigator:
      active === "absent" ? {} : { userActivation: { hasBeenActive: active } },
    dispatchEvent: (event: UnloadEvent): boolean => {
      const e = event as UnloadEvent & {
        type: string;
        preventDefault(): void;
        returnValue: unknown;
      };
      dispatched.push(e.type);
      listener(e);
      return !e.defaultPrevented;
    },
  };
  return { window, dispatched };
};

/** Runs the check from its source in a fresh context, as Chrome does. */
const check = (
  controls: readonly FormControl[],
  page: Page = {},
): { readonly result: unknown; readonly dispatched: readonly string[] } => {
  const { window, dispatched } = fakeWindow(controls, page);
  const result: unknown = runInNewContext(`(${hasUnsubmittedForm})()`, window);
  return { result, dispatched };
};

const finds = (controls: readonly FormControl[], page: Page = {}): void =>
  assert.deepEqual(check(controls, page), { result: true, dispatched: [] });

const passes = (controls: readonly FormControl[], page: Page = {}): void =>
  assert.deepEqual(check(controls, page), {
    result: false,
    dispatched: ["beforeunload"],
  });

describe("hasUnsubmittedForm: controls", () => {
  it("finds an edited text-like input", () => {
    for (const type of [
      "text",
      "email",
      "search",
      "password",
      "number",
      "date",
    ]) {
      finds([input({ type, value: "1", defaultValue: "" })]);
      passes([input({ type, value: "1", defaultValue: "1" })]);
    }
  });

  it("compares with the sanitised default a reset would give", () => {
    passes([input({ type: "number", defaultValue: "1,5", value: "" })]);
    passes([input({ type: "number", defaultValue: "+1", value: "" })]);
    passes([input({ type: "email", defaultValue: "a@b.c ", value: "a@b.c" })]);
    passes([
      input({
        type: "email",
        multiple: true,
        defaultValue: "a@b.c, d@e.f",
        value: "a@b.c,d@e.f",
      }),
    ]);
    passes([
      input({
        type: "datetime-local",
        defaultValue: "2026-11-19T10:00:00",
        value: "2026-11-19T10:00",
      }),
    ]);
    passes([input({ defaultValue: "two\nlines", value: "twolines" })]);
    passes([textarea({ defaultValue: "a\r\nb", value: "a\nb" })]);
  });

  it("finds an edit to a field whose default is sanitised", () => {
    finds([input({ type: "number", defaultValue: "1,5", value: "15" })]);
    finds([input({ type: "email", defaultValue: "a@b.c ", value: "a@b.d" })]);
    finds([
      input({
        type: "datetime-local",
        defaultValue: "2026-11-19T10:00:00",
        value: "2026-11-19T11:00",
      }),
    ]);
  });

  it("finds an edited textarea", () => {
    finds([textarea({ value: "draft" })]);
    passes([textarea({ value: "kept", defaultValue: "kept" })]);
  });

  it("finds a field the user typed into whose default followed it", () => {
    // React copies a controlled field's value into defaultValue.
    finds([input({ value: "typed", defaultValue: "typed", interacted: true })]);
    finds([
      textarea({ value: "typed", defaultValue: "typed", interacted: true }),
    ]);
    passes([input({ value: "typed", defaultValue: "typed" })]);
    passes([input({ interacted: true })]);
    passes([
      input({
        value: "typed",
        defaultValue: "typed",
        interacted: true,
        readOnly: true,
      }),
    ]);
  });

  it("passes such a field in a browser without the user-validity selectors", () => {
    passes([
      input({
        value: "typed",
        defaultValue: "typed",
        interacted: true,
        oldBrowser: true,
      }),
    ]);
    finds([input({ value: "edited", oldBrowser: true })]);
  });

  it("finds a toggled checkbox or radio", () => {
    for (const type of ["checkbox", "radio"]) {
      finds([input({ type, checked: true })]);
      finds([input({ type, defaultChecked: true })]);
      passes([input({ type, checked: true, defaultChecked: true })]);
    }
  });

  it("finds a chosen file, even in a hidden input", () => {
    finds([input({ type: "file", files: { length: 1 } })]);
    finds([input({ type: "file", files: { length: 1 }, rendered: false })]);
    passes([input({ type: "file", files: { length: 0 } })]);
    passes([input({ type: "file", files: { length: 1 }, disabled: true })]);
  });

  it("finds a changed choice in a drop-down", () => {
    finds([select([option(false, false), option(true, false)])]);
    finds([select([option(true, false), option(false, true)])]);
  });

  it("passes a drop-down showing its default choice", () => {
    passes([select([option(true, false), option(false, false)])]);
    passes([select([option(false, false, true), option(true, false)])]);
    passes([select([option(false, true), option(true, true)])]);
  });

  it("passes a list box with nothing chosen", () => {
    passes([select([option(false, false), option(false, false)], { size: 3 })]);
    finds([select([option(true, false), option(false, false)], { size: 3 })]);
  });

  it("finds any changed option in a multiple select", () => {
    finds([
      select([option(true, true), option(true, false)], { multiple: true }),
    ]);
    passes([
      select([option(true, true), option(false, false)], { multiple: true }),
    ]);
  });

  it("ignores the excluded input types", () => {
    for (const type of [
      "hidden",
      "button",
      "submit",
      "reset",
      "image",
      "range",
      "color",
    ]) {
      passes([
        input({ type, value: "1", checked: true, files: { length: 1 } }),
      ]);
    }
  });

  it("ignores a disabled, read-only or unrendered control", () => {
    passes([input({ value: "x", disabled: true })]);
    passes([input({ value: "x", readOnly: true })]);
    passes([textarea({ value: "x", readOnly: true })]);
    passes([input({ value: "x", rendered: false })]);
    passes([
      select([option(false, false), option(true, false)], { disabled: true }),
    ]);
  });

  it("applies read-only only where the attribute applies", () => {
    finds([input({ type: "checkbox", checked: true, readOnly: true })]);
  });

  it("finds one edited control among clean ones", () => {
    finds([input(), textarea(), input({ type: "checkbox", checked: true })]);
  });

  it("looks inside open shadow roots, nested too", () => {
    const edited = input({ value: "draft" });
    finds([], { hosts: [{ shadowRoot: root([edited]) }] });
    finds([], {
      hosts: [{ shadowRoot: root([], [{ shadowRoot: root([edited]) }]) }],
    });
    passes([], { hosts: [{ shadowRoot: root([input()]) }] });
  });
});

describe("hasUnsubmittedForm: beforeunload", () => {
  it("dispatches a cancelable beforeunload only when no control differs", () => {
    passes([]);
    passes([input()]);
  });

  it("finds an activated page whose listener calls preventDefault", () => {
    assert.deepEqual(
      check([], { listener: (event) => event.preventDefault() }),
      { result: true, dispatched: ["beforeunload"] },
    );
  });

  it("finds an activated page whose handler sets a returnValue", () => {
    // An `onbeforeunload` handler's return value lands in returnValue.
    assert.deepEqual(
      check([], {
        listener: (event) => {
          event.returnValue = "Leave site?";
        },
      }),
      { result: true, dispatched: ["beforeunload"] },
    );
  });

  it("does not dispatch on a page the user has not activated", () => {
    const listener: Listener = (event) => event.preventDefault();
    for (const active of [false, "absent"] as const) {
      assert.deepEqual(check([], { listener, active }), {
        result: false,
        dispatched: [],
      });
    }
  });
});

describe("tabFormState", () => {
  it("is unsubmitted when any frame is", () => {
    assert.equal(
      tabFormState([{ result: false }, {}, { result: true }]),
      "unsubmitted",
    );
  });

  it("is clean when every frame answered false", () => {
    assert.equal(tabFormState([{ result: false }, { result: false }]), "clean");
  });

  it("is unchecked with no answer, or a frame without one", () => {
    assert.equal(tabFormState([]), "unchecked");
    assert.equal(tabFormState([{}]), "unchecked");
    assert.equal(
      tabFormState([{ result: false }, { result: null }]),
      "unchecked",
    );
  });
});
