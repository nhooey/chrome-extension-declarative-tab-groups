// The edge of `install` and `uninstall`: it finds the package from the
// command's real path, looks at each link's place through `Files`, and
// carries out the planned steps, unless the plan refuses or the run is a
// dry run. `nodeFiles` is the real file system.

import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  readlink,
  realpath,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";

import type { Environment } from "../host/socket-path.ts";
import { type SetupCommand, usageText } from "./arguments.ts";
import { PROGRAM } from "./help.ts";
import {
  describeInstallStep,
  describeUninstallStep,
  type Entry,
  type InstallStep,
  linksTo,
  loadingInstructions,
  placeList,
  type Places,
  places,
  planInstall,
  planUninstall,
  refusals,
  type UninstallStep,
} from "./install-plan.ts";
import { PACKAGE_LAYOUT, packageRootOf } from "./layout.ts";
import { EXIT, type Output } from "./output.ts";

/** The file system, as far as `install` and `uninstall` use it. */
export type Files = {
  readonly realPath: (path: string) => Promise<string>;
  /** What is at `path`, not following a link there. */
  readonly lookAt: (path: string) => Promise<Entry>;
  /** What `path` leads to, following links. */
  readonly lookThrough: (path: string) => Promise<Entry>;
  /** Makes the folder and any missing folder above it. */
  readonly makeFolder: (path: string) => Promise<void>;
  readonly link: (path: string, target: string) => Promise<void>;
  readonly removeLink: (path: string) => Promise<void>;
};

export type SetupIo = {
  readonly env: Environment;
  /** `process.platform`. */
  readonly platform: string;
  /** The path of the running command's file, which may be reached through links. */
  readonly entry: string;
  readonly files: Files;
};

/** The mode of a folder `install` makes: u=rwx,go=rx, narrowed further by the umask. */
const FOLDER_MODE =
  constants.S_IRWXU |
  constants.S_IRGRP |
  constants.S_IXGRP |
  constants.S_IROTH |
  constants.S_IXOTH;

const codeOf = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;

/** The entry for a path that is not there, or lies under something that is not a folder. */
const absent = (error: unknown, entry: Entry): Entry => {
  const code = codeOf(error);
  if (code === "ENOENT" || code === "ENOTDIR") {
    return entry;
  }
  throw error;
};

export const nodeFiles: Files = {
  realPath: (path) => realpath(path),
  lookAt: async (path) => {
    try {
      const status = await lstat(path);
      return status.isSymbolicLink()
        ? { kind: "link", target: await readlink(path) }
        : status.isDirectory()
          ? { kind: "folder" }
          : { kind: "other" };
    } catch (error) {
      return absent(error, { kind: "missing" });
    }
  },
  lookThrough: async (path) => {
    try {
      return (await stat(path)).isDirectory()
        ? { kind: "folder" }
        : { kind: "other" };
    } catch (error) {
      // A link that leads nowhere is there, but is no folder to put a link in.
      const there = await lstat(path).then(
        () => true,
        () => false,
      );
      return there ? { kind: "other" } : absent(error, { kind: "missing" });
    }
  },
  makeFolder: async (path) => {
    await mkdir(path, { recursive: true, mode: FOLDER_MODE });
  },
  link: (path, target) => symlink(target, path),
  removeLink: (path) => unlink(path),
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const failed = (stdout: string, message: string): Output => ({
  stdout,
  stderr: `${PROGRAM}: ${message}\n`,
  status: EXIT.failure,
});

const lines = (text: readonly string[]): string =>
  text.map((line) => `${line}\n`).join("");

const DRY_RUN_NOTE = "--dry-run: nothing is changed";

/** Carries out the steps in order, stopping at the first that fails. */
const carryOut = async <Step>(
  steps: readonly Step[],
  describe: (step: Step) => string,
  act: (step: Step) => Promise<void>,
): Promise<{ readonly done: string; readonly error: string | null }> => {
  const done: string[] = [];
  for (const step of steps) {
    try {
      await act(step);
    } catch (error) {
      return {
        done: lines(done),
        error: `${describe(step)} failed: ${messageOf(error)}`,
      };
    }
    done.push(describe(step));
  }
  return { done: lines(done), error: null };
};

const installAct =
  (files: Files) =>
  async (step: InstallStep): Promise<void> => {
    switch (step.kind) {
      case "make-folder":
        return files.makeFolder(step.path);
      case "link":
        return files.link(step.path, step.target);
      case "replace-link":
        await files.removeLink(step.path);
        return files.link(step.path, step.target);
      case "keep-link":
      case "refuse":
        return;
    }
  };

const uninstallAct =
  (files: Files) =>
  async (step: UninstallStep): Promise<void> =>
    step.kind === "remove-link" ? files.removeLink(step.path) : undefined;

const install = async (
  dryRun: boolean,
  at: Places,
  io: SetupIo,
): Promise<Output> => {
  const entry = await io.files.realPath(io.entry);
  const root = packageRootOf(entry);
  if (root === null) {
    return failed(
      "",
      `install runs only from an installed package, where the command is ${PACKAGE_LAYOUT.command}; it is running from ${entry}`,
    );
  }
  const links = linksTo(root, placeList(at));
  const steps = planInstall(
    await Promise.all(
      links.map(async (link) => ({
        link,
        at: await io.files.lookAt(link.path),
        folder: await io.files.lookThrough(link.folder),
        target: await io.files.lookThrough(link.target),
      })),
    ),
  );
  const refused = refusals(steps);
  if (refused.length > 0) {
    return failed(
      "",
      `install changes nothing, since a path it needs holds something else:\n${refused
        .map((step) => `  ${step.path} ${step.reason}\n`)
        .join("")}Move each away, then run install again.`,
    );
  }
  const instructions = loadingInstructions(at.extension.path);
  if (dryRun) {
    return {
      stdout: `${lines([DRY_RUN_NOTE, ...steps.map(describeInstallStep)])}\n${instructions}`,
      stderr: "",
      status: EXIT.success,
    };
  }
  const result = await carryOut(
    steps,
    describeInstallStep,
    installAct(io.files),
  );
  return result.error === null
    ? {
        stdout: `${result.done}\n${instructions}`,
        stderr: "",
        status: EXIT.success,
      }
    : failed(result.done, result.error);
};

const uninstall = async (
  dryRun: boolean,
  at: Places,
  io: SetupIo,
): Promise<Output> => {
  const steps = planUninstall(
    await Promise.all(
      placeList(at).map(async (place) => ({
        place,
        at: await io.files.lookAt(place.path),
      })),
    ),
  );
  if (dryRun) {
    return {
      stdout: lines([DRY_RUN_NOTE, ...steps.map(describeUninstallStep)]),
      stderr: "",
      status: EXIT.success,
    };
  }
  const result = await carryOut(
    steps,
    describeUninstallStep,
    uninstallAct(io.files),
  );
  return result.error === null
    ? { stdout: result.done, stderr: "", status: EXIT.success }
    : failed(result.done, result.error);
};

/** Runs `install` or `uninstall`: what it prints and exits with. */
export const runSetup = async (
  command: SetupCommand,
  io: SetupIo,
): Promise<Output> => {
  if (io.platform !== "darwin") {
    return failed(
      "",
      `${command.command} works only on macOS, and this is ${io.platform}`,
    );
  }
  const at = places(io.env);
  if (!at.ok) {
    return {
      stdout: "",
      stderr: usageText(at.error, command.command),
      status: EXIT.usage,
    };
  }
  try {
    return await (command.command === "install" ? install : uninstall)(
      command.dryRun,
      at.value,
      io,
    );
  } catch (error) {
    return failed("", `${command.command} failed: ${messageOf(error)}`);
  }
};
