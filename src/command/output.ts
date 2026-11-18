// The command's request for a parsed command, and what it prints and
// exits with for the answer it gets. Pure.

import {
  encode,
  failure,
  type Failure,
  parseResponse,
  PROTOCOL_VERSION,
  type Request,
  type Response,
  type SetSuccess,
  type Success,
} from "../protocol/index.ts";
import type { CommandValue } from "./arguments.ts";
import { PROGRAM } from "./help.ts";

/** The exit statuses, as `--help` lists them. */
export const EXIT = {
  success: 0,
  failure: 1,
  usage: 2,
  kept: 3,
  notConnected: 4,
} as const;

/** The URLs of a `--urls-from` text: one per line, surrounding whitespace and blank lines ignored. */
export const urlsFromText = (text: string): readonly string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** The request a command sends; `urls` are `set`'s, from its arguments or its file. */
export const requestFor = (
  command: CommandValue,
  urls: readonly string[],
): Request => {
  switch (command.command) {
    case "set":
      return {
        protocol: PROTOCOL_VERSION,
        command: "set",
        group: command.group,
        urls,
        ...(command.color === undefined ? {} : { color: command.color }),
        ...(command.createWindow ? { createWindow: true } : {}),
        ...(command.statusPage === undefined
          ? {}
          : { statusPage: command.statusPage }),
      };
    case "get":
      return {
        protocol: PROTOCOL_VERSION,
        command: "get",
        group: command.group,
      };
    case "status":
      return { protocol: PROTOCOL_VERSION, command: "status" };
  }
};

/** The exit status for a response. */
export const exitStatus = (response: Response): number =>
  !response.ok
    ? response.error.code === "not-connected"
      ? EXIT.notConnected
      : EXIT.failure
    : response.command === "set" && response.kept.length > 0
      ? EXIT.kept
      : EXIT.success;

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/** The C0 controls, DEL and the C1 controls, which a terminal may act on. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * The text with each control character replaced by U+FFFD, so a page's
 * title cannot move the cursor or send a terminal an escape sequence.
 */
export const printable = (text: string): string => text.replace(CONTROL, "�");

const renderSet = (response: SetSuccess): readonly string[] => [
  `${JSON.stringify(response.group.title)} in window ${response.group.windowId}${response.group.created ? ", created" : ""}: opened ${response.opened}, closed ${response.closed}`,
  ...(response.kept.length === 0
    ? []
    : [
        `kept ${plural(response.kept.length, "tab", "tabs")} with an unsubmitted form:`,
        ...response.kept.map((tab) => `  ${tab.title}  ${tab.url}`),
      ]),
  ...(response.unchecked === 0
    ? []
    : [
        `${plural(response.unchecked, "tab was", "tabs were")} closed without the unsubmitted-form check`,
      ]),
  ...(response.loading === 0
    ? []
    : [`${plural(response.loading, "tab is", "tabs are")} still loading`]),
];

/** The readable account of a success, as lines. */
export const renderSuccess = (
  response: Success,
  version: string,
): readonly string[] => {
  switch (response.command) {
    case "set":
      return renderSet(response);
    case "get":
      return response.tabs.map((tab) => tab.url);
    case "status":
      return [
        `${PROGRAM} ${version}`,
        `extension ${response.extension}`,
        `Google Chrome ${response.chrome}`,
      ];
  }
};

/** The line a failure prints on standard error. */
export const renderFailure = (response: Failure): string =>
  `${PROGRAM}: ${response.error.code}: ${printable(response.error.message)}\n`;

/** What the command received: a response line, or no answer at all. */
export type Outcome =
  | { readonly kind: "line"; readonly line: string }
  | { readonly kind: "not-connected"; readonly message: string };

export type Output = {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
};

const lines = (text: readonly string[]): string =>
  text.map((line) => `${printable(line)}\n`).join("");

/**
 * What the command prints and exits with. The readable account holds no
 * control character; with `--json` standard output gets the response line
 * exactly as received, or, when nothing answered, the `not-connected`
 * failure the command stands in with.
 */
export const output = (
  command: CommandValue,
  outcome: Outcome,
  version: string,
): Output => {
  const parsed =
    outcome.kind === "line"
      ? parseResponse(outcome.line)
      : { ok: true as const, value: failure("not-connected", outcome.message) };
  const response: Response = parsed.ok ? parsed.value : parsed.error;
  const json = outcome.kind === "line" ? `${outcome.line}\n` : encode(response);
  return {
    stdout: command.json
      ? json
      : response.ok
        ? lines(renderSuccess(response, version))
        : "",
    stderr: response.ok ? "" : renderFailure(response),
    status: exitStatus(response),
  };
};
