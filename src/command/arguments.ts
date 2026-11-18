// The command's arguments, parsed into what to do: print help or the
// version, run a subcommand, or report a usage error. Pure.

import { type Color, COLORS } from "../protocol/index.ts";
import { GET_HELP, MAIN_HELP, PROGRAM, SET_HELP, STATUS_HELP } from "./help.ts";

/** Where `set` takes its URLs from. */
export type UrlSource =
  | { readonly kind: "arguments"; readonly urls: readonly string[] }
  /** A file, one URL per line; `-` is standard input. */
  | { readonly kind: "file"; readonly path: string };

export type SetCommand = {
  readonly command: "set";
  readonly group: string;
  readonly color?: Color;
  readonly createWindow: boolean;
  readonly statusPage?: boolean;
  readonly urls: UrlSource;
  readonly json: boolean;
};

export type GetCommand = {
  readonly command: "get";
  readonly group: string;
  readonly json: boolean;
};

export type StatusCommand = {
  readonly command: "status";
  readonly json: boolean;
};

export type CommandValue = SetCommand | GetCommand | StatusCommand;

export type Invocation =
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "version" }
  | { readonly kind: "run"; readonly command: CommandValue }
  /** `message` names the fault; `subcommand` is the one whose `--help` explains, if any. */
  | {
      readonly kind: "usage-error";
      readonly message: string;
      readonly subcommand: Subcommand | null;
    };

/** The options a subcommand takes: whether each takes a value. */
type OptionSpec = { readonly [name: string]: "value" | "flag" };

type Scanned = {
  readonly options: ReadonlyMap<string, string | true>;
  readonly positionals: readonly string[];
};

type Scan =
  | { readonly ok: true; readonly value: Scanned }
  | { readonly ok: false; readonly message: string };

const isOption = (argument: string): boolean =>
  argument.startsWith("-") && argument !== "-";

/**
 * Splits the arguments into options and positionals. An option's value is
 * the next argument or follows `=`; `--` ends the options. An unknown
 * option, a repeated one, a missing value, or a value given to a flag is
 * a fault.
 */
const scan = (args: readonly string[], spec: OptionSpec): Scan => {
  const step = (
    index: number,
    options: ReadonlyMap<string, string | true>,
    positionals: readonly string[],
  ): Scan => {
    const argument = args[index];
    if (argument === undefined) {
      return { ok: true, value: { options, positionals } };
    }
    if (argument === "--") {
      return {
        ok: true,
        value: {
          options,
          positionals: [...positionals, ...args.slice(index + 1)],
        },
      };
    }
    if (!isOption(argument)) {
      return step(index + 1, options, [...positionals, argument]);
    }
    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const kind = Object.hasOwn(spec, name) ? spec[name] : undefined;
    if (kind === undefined) {
      return { ok: false, message: `unknown option ${name}` };
    }
    if (options.has(name)) {
      return { ok: false, message: `${name} is given more than once` };
    }
    if (kind === "flag") {
      return equals === -1
        ? step(index + 1, new Map([...options, [name, true]]), positionals)
        : { ok: false, message: `${name} takes no value` };
    }
    const value = equals === -1 ? args[index + 1] : argument.slice(equals + 1);
    if (value === undefined) {
      return { ok: false, message: `${name} needs a value` };
    }
    return step(
      index + (equals === -1 ? 2 : 1),
      new Map([...options, [name, value]]),
      positionals,
    );
  };
  return step(0, new Map(), []);
};

const SUBCOMMANDS = {
  set: {
    help: SET_HELP,
    spec: {
      "--group": "value",
      "--color": "value",
      "--create-window": "flag",
      "--status-page": "flag",
      "--no-status-page": "flag",
      "--urls-from": "value",
      "--json": "flag",
    },
  },
  get: { help: GET_HELP, spec: { "--group": "value", "--json": "flag" } },
  status: { help: STATUS_HELP, spec: { "--json": "flag" } },
} as const satisfies {
  readonly [name: string]: { readonly help: string; readonly spec: OptionSpec };
};

export type Subcommand = keyof typeof SUBCOMMANDS;

const isSubcommand = (name: string): name is Subcommand =>
  Object.hasOwn(SUBCOMMANDS, name);

const isColor = (value: string): value is Color =>
  (COLORS as readonly string[]).includes(value);

const usage = (message: string, subcommand: Subcommand | null): Invocation => ({
  kind: "usage-error",
  message,
  subcommand,
});

/** Whether `--help` or `-h` comes before any `--`. */
const asksForHelp = (args: readonly string[]): boolean => {
  const end = args.indexOf("--");
  return (end === -1 ? args : args.slice(0, end)).some(
    (argument) => argument === "--help" || argument === "-h",
  );
};

const stringOption = (scanned: Scanned, name: string): string | undefined => {
  const value = scanned.options.get(name);
  return typeof value === "string" ? value : undefined;
};

const flag = (scanned: Scanned, name: string): boolean =>
  scanned.options.get(name) === true;

const parseSet = (scanned: Scanned): Invocation => {
  const group = stringOption(scanned, "--group");
  if (group === undefined) {
    return usage("set needs --group <title>", "set");
  }
  const color = stringOption(scanned, "--color");
  if (color !== undefined && !isColor(color)) {
    return usage(
      `--color must be one of ${COLORS.join(", ")}, not ${JSON.stringify(color)}`,
      "set",
    );
  }
  if (flag(scanned, "--status-page") && flag(scanned, "--no-status-page")) {
    return usage(
      "--status-page and --no-status-page cannot both be given",
      "set",
    );
  }
  const from = stringOption(scanned, "--urls-from");
  if (from !== undefined && scanned.positionals.length > 0) {
    return usage("give URLs as arguments or with --urls-from, not both", "set");
  }
  const statusPage = flag(scanned, "--status-page")
    ? { statusPage: true }
    : flag(scanned, "--no-status-page")
      ? { statusPage: false }
      : {};
  return {
    kind: "run",
    command: {
      command: "set",
      group,
      ...(color === undefined ? {} : { color }),
      createWindow: flag(scanned, "--create-window"),
      ...statusPage,
      urls:
        from === undefined
          ? { kind: "arguments", urls: scanned.positionals }
          : { kind: "file", path: from },
      json: flag(scanned, "--json"),
    },
  };
};

const parseSubcommand = (
  name: Subcommand,
  args: readonly string[],
): Invocation => {
  const { help, spec } = SUBCOMMANDS[name];
  if (asksForHelp(args)) {
    return { kind: "help", text: help };
  }
  const scanned = scan(args, spec);
  if (!scanned.ok) {
    return usage(scanned.message, name);
  }
  if (name === "set") {
    return parseSet(scanned.value);
  }
  if (scanned.value.positionals.length > 0) {
    return usage(
      `${name} takes no arguments, but was given ${JSON.stringify(scanned.value.positionals[0])}`,
      name,
    );
  }
  const json = flag(scanned.value, "--json");
  if (name === "status") {
    return { kind: "run", command: { command: "status", json } };
  }
  const group = stringOption(scanned.value, "--group");
  return group === undefined
    ? usage("get needs --group <title>", name)
    : { kind: "run", command: { command: "get", group, json } };
};

/** What the command's arguments, without the program's path, ask for. */
export const parseArguments = (args: readonly string[]): Invocation => {
  const [first, ...rest] = args;
  if (first === undefined) {
    return usage("a command is needed: set, get or status", null);
  }
  if (first === "--help" || first === "-h") {
    return { kind: "help", text: MAIN_HELP };
  }
  if (first === "--version") {
    return rest.length === 0
      ? { kind: "version" }
      : usage("--version takes no arguments", null);
  }
  if (isSubcommand(first)) {
    return parseSubcommand(first, rest);
  }
  return usage(
    isOption(first)
      ? `unknown option ${first}`
      : `unknown command ${JSON.stringify(first)}; the commands are set, get and status`,
    null,
  );
};

/** The lines a usage error prints on standard error. */
export const usageText = (
  message: string,
  subcommand: Subcommand | null,
): string =>
  `${PROGRAM}: ${message}\nRun "${subcommand === null ? PROGRAM : `${PROGRAM} ${subcommand}`} --help" for usage.\n`;
