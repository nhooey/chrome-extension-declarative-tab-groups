// The unsubmitted-form check. Chrome serialises `hasUnsubmittedForm` and
// runs it in every frame of a tab, in the extension's isolated world, so it
// imports nothing and refers to nothing outside its own body; the rest of
// this module is types, which compile away, and the pure fold of the
// frames' results.

/** What the form check found in one tab. */
export type FormState = "clean" | "unsubmitted" | "unchecked";

/** The members of an element the check reads, as the DOM has them. */
type Rendered = {
  matches(selectors: string): boolean;
  checkVisibility(): boolean;
};

export type InputControl = Rendered & {
  readonly localName: "input";
  /** The type as the DOM reports it: lowercase, `text` when unknown. */
  readonly type: string;
  readonly multiple: boolean;
  readonly readOnly: boolean;
  readonly value: string;
  readonly defaultValue: string;
  readonly checked: boolean;
  readonly defaultChecked: boolean;
  readonly files: { readonly length: number } | null;
};

export type TextAreaControl = Rendered & {
  readonly localName: "textarea";
  readonly readOnly: boolean;
  readonly value: string;
  readonly defaultValue: string;
};

export type SelectOption = {
  readonly selected: boolean;
  readonly defaultSelected: boolean;
  matches(selectors: string): boolean;
};

export type SelectControl = Rendered & {
  readonly localName: "select";
  readonly multiple: boolean;
  /** The `size` attribute's value, 0 when absent. */
  readonly size: number;
  readonly selectedIndex: number;
  readonly options: ArrayLike<SelectOption>;
};

export type FormControl = InputControl | TextAreaControl | SelectControl;

/** An element that may host an open shadow root. */
export type ShadowHost = { readonly shadowRoot: QueryRoot | null };

/** A document or a shadow root, as the check queries it. */
export type QueryRoot = {
  querySelectorAll(
    selectors: "input, textarea, select",
  ): ArrayLike<FormControl>;
  querySelectorAll(selectors: "*"): ArrayLike<ShadowHost>;
};

/**
 * A detached `input` or `textarea` that the check makes to read what a
 * form reset would give a control. Only an `input`'s `type` and `multiple`
 * are set.
 */
export type Probe = { type: string; multiple: boolean; value: string };

/** A `BeforeUnloadEvent`, as `document.createEvent` makes it. */
export type UnloadEvent = {
  initEvent(type: string, bubbles: boolean, cancelable: boolean): void;
  readonly defaultPrevented: boolean;
  readonly returnValue: unknown;
};

/** The members of a frame's window the check reads. */
export type FormCheckWindow = {
  readonly document: QueryRoot & {
    createElement(localName: "input" | "textarea"): Probe;
    createEvent(kind: "BeforeUnloadEvent"): UnloadEvent;
  };
  readonly navigator?: {
    readonly userActivation?: { readonly hasBeenActive: boolean };
  };
  dispatchEvent(event: UnloadEvent): boolean;
};

/**
 * Whether the frame holds an unsubmitted form: a control the user can edit
 * whose state differs from what a form reset would give it, or a text
 * field the user has interacted with and left non-empty; or else a page the
 * user has activated that cancels a `beforeunload` event. It looks through
 * open shadow roots too. Chrome calls it with no argument, so `page` is the
 * frame's own window; a test passes a fake.
 *
 * `range` and `color` inputs are not compared: their reset value depends
 * on attributes such as `min`, `max` and `step`, and on an untouched page
 * it differs from `defaultValue` whenever the `value` attribute is absent.
 */
export const hasUnsubmittedForm = (
  page: FormCheckWindow = globalThis as unknown as FormCheckWindow,
): boolean => {
  // A selector the browser does not know throws; it then matches nothing.
  const matches = (
    element: { matches(selectors: string): boolean },
    selectors: string,
  ): boolean => {
    try {
      return element.matches(selectors);
    } catch {
      return false;
    }
  };

  // The browser sanitises a default before a reset uses it (a number input
  // drops "1,5", an email input trims spaces), so the value a reset would
  // give is read from a detached control of the same kind.
  const resetValue = (control: InputControl | TextAreaControl): string => {
    const probe = page.document.createElement(control.localName);
    if (control.localName === "input") {
      probe.type = control.type;
      probe.multiple = control.multiple;
    }
    probe.value = control.defaultValue;
    return probe.value;
  };

  // React copies a controlled field's value into `defaultValue` on every
  // render, so a field the user has interacted with (`:user-valid` or
  // `:user-invalid`) that holds text also counts.
  const textDiffers = (control: InputControl | TextAreaControl): boolean =>
    !control.readOnly &&
    (control.value !== resetValue(control) ||
      (control.value !== "" && matches(control, ":user-valid, :user-invalid")));

  const inputDiffers = (input: InputControl): boolean => {
    switch (input.type) {
      case "hidden":
      case "button":
      case "submit":
      case "reset":
      case "image":
      case "range":
      case "color":
        return false;
      case "checkbox":
      case "radio":
        return input.checked !== input.defaultChecked;
      case "file":
        return (input.files?.length ?? 0) > 0;
      default:
        return textDiffers(input);
    }
  };

  // A single-choice select's default is its last option marked `selected`;
  // without one, a drop-down shows its first enabled option and a list box
  // shows none, so comparing each option's `selected` to `defaultSelected`
  // would count every untouched drop-down.
  const selectDiffers = (select: SelectControl): boolean => {
    const options = Array.from(select.options);
    if (select.multiple) {
      return options.some(
        (option) => option.selected !== option.defaultSelected,
      );
    }
    const marked = options
      .map((option) => option.defaultSelected)
      .lastIndexOf(true);
    const expected =
      marked !== -1
        ? marked
        : select.size > 1
          ? -1
          : options.findIndex((option) => !matches(option, ":disabled"));
    return select.selectedIndex !== expected;
  };

  const differs = (control: FormControl): boolean => {
    switch (control.localName) {
      case "input":
        return inputDiffers(control);
      case "textarea":
        return textDiffers(control);
      case "select":
        return selectDiffers(control);
    }
  };

  // `:disabled` also covers a control inside a disabled fieldset. A file
  // input counts even when hidden, as drop zones hide theirs.
  const editable = (control: FormControl): boolean =>
    !matches(control, ":disabled") &&
    ((control.localName === "input" && control.type === "file") ||
      control.checkVisibility());

  const controlsIn = (root: QueryRoot): readonly FormControl[] => [
    ...Array.from(root.querySelectorAll("input, textarea, select")),
    ...Array.from(root.querySelectorAll("*")).flatMap((element) =>
      element.shadowRoot === null ? [] : controlsIn(element.shadowRoot),
    ),
  ];

  if (
    controlsIn(page.document).some(
      (control) => differs(control) && editable(control),
    )
  ) {
    return true;
  }

  // Chrome never asks before leaving a page the user has not activated, so
  // a page that cancels `beforeunload` unconditionally is not kept forever.
  if (page.navigator?.userActivation?.hasBeenActive !== true) {
    return false;
  }

  // Made through createEvent so that it is a BeforeUnloadEvent, for which
  // an `onbeforeunload` handler's return value cancels the event.
  const event = page.document.createEvent("BeforeUnloadEvent");
  event.initEvent("beforeunload", false, true);
  page.dispatchEvent(event);
  return (
    event.defaultPrevented ||
    (typeof event.returnValue === "string" && event.returnValue !== "")
  );
};

/** One frame's outcome, as `chrome.scripting.executeScript` reports it. */
export type FrameResult = { readonly result?: unknown };

/**
 * Folds one tab's frame results into its form state: `unsubmitted` when any
 * frame holds an unsubmitted form, else `clean` when every frame answered,
 * else `unchecked`, which includes a tab with no answer at all.
 */
export const tabFormState = (frames: readonly FrameResult[]): FormState =>
  frames.some((frame) => frame.result === true)
    ? "unsubmitted"
    : frames.length > 0 && frames.every((frame) => frame.result === false)
      ? "clean"
      : "unchecked";
