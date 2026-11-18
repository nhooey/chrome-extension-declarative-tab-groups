// What `install` and `uninstall` do, as a pure function of what is on
// disk: the two links of a user's install, and the ordered steps that make
// or remove them. `install.ts` looks at the disk and carries the steps out.
//
// The links are the host's manifest in Google Chrome's native-messaging
// folder, the only browser folder this tool writes, and the unpacked
// extension at a path that stays the same from one package to the next.

import { dirname, isAbsolute, join } from "node:path";

import type { Environment } from "../host/socket-path.ts";
import type { Result } from "../protocol/index.ts";
import {
  HOME_LAYOUT,
  HOST_MANIFEST_FILE,
  PACKAGE_HOST_MANIFEST,
  PACKAGE_LAYOUT,
} from "./layout.ts";

/** What is at a path: a link there is not followed, and `other` is anything that is neither a folder nor a link. */
export type Entry =
  | { readonly kind: "missing" }
  | { readonly kind: "folder" }
  | { readonly kind: "link"; readonly target: string }
  | { readonly kind: "other" };

/**
 * Where one of this tool's links goes, and `mark`, how the path of the
 * file it points at ends in any package of this tool's.
 */
export type Place = {
  readonly path: string;
  readonly folder: string;
  readonly mark: string;
};

/** A link `install` makes: its place and the file of this package it points at. */
export type Link = Place & { readonly target: string };

/** A variable's value, or null when it is unset, empty or not absolute, as the XDG base directory specification reads it. */
const absoluteVariable = (env: Environment, name: string): string | null => {
  const value = env[name];
  return value === undefined || !isAbsolute(value) ? null : value;
};

const place = (path: string, mark: string): Place => ({
  path,
  folder: dirname(path),
  mark,
});

export type Places = {
  readonly hostManifest: Place;
  readonly extension: Place;
};

/**
 * The places of the two links: the host's manifest in
 * `$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/`,
 * and the extension at `${XDG_DATA_HOME:-$HOME/.local/share}/declarative-tab-groups/extension`.
 */
export const places = (env: Environment): Result<Places, string> => {
  const home = absoluteVariable(env, "HOME");
  if (home === null) {
    return { ok: false, error: "HOME must be an absolute path" };
  }
  const data =
    absoluteVariable(env, "XDG_DATA_HOME") ?? join(home, ".local/share");
  return {
    ok: true,
    value: {
      hostManifest: place(
        join(home, HOME_LAYOUT.hostManifests, HOST_MANIFEST_FILE),
        PACKAGE_HOST_MANIFEST,
      ),
      extension: place(
        join(data, HOME_LAYOUT.extension),
        PACKAGE_LAYOUT.extension,
      ),
    },
  };
};

/** The places in the order the steps take them. */
export const placeList = (at: Places): readonly Place[] => [
  at.hostManifest,
  at.extension,
];

/** The links to the package whose root is `root`, at the given places. */
export const linksTo = (root: string, at: readonly Place[]): readonly Link[] =>
  at.map((place) => ({ ...place, target: join(root, place.mark) }));

/** Whether a link's target is a file of this tool's, in this package or another. */
export const isOurs = (target: string, mark: string): boolean =>
  isAbsolute(target) && target.endsWith(`/${mark}`);

/** What `install` sees for one link. */
export type InstallView = {
  readonly link: Link;
  /** What is at the link's path. */
  readonly at: Entry;
  /** What the link's folder is, following links. */
  readonly folder: Entry;
  /** What the package's file is, following links. */
  readonly target: Entry;
};

export type InstallStep =
  | { readonly kind: "make-folder"; readonly path: string }
  | { readonly kind: "link"; readonly path: string; readonly target: string }
  | {
      readonly kind: "replace-link";
      readonly path: string;
      readonly target: string;
      readonly previous: string;
    }
  | {
      readonly kind: "keep-link";
      readonly path: string;
      readonly target: string;
    }
  | { readonly kind: "refuse"; readonly path: string; readonly reason: string };

/** Why a path that holds something other than this tool's link is left alone. */
const notOurs = (at: Entry): string | null => {
  switch (at.kind) {
    case "missing":
      return null;
    case "folder":
      return "is a folder, not this tool's link";
    case "other":
      return "is a file, not this tool's link";
    case "link":
      return `is a link to ${at.target}, which is not this tool's`;
  }
};

const folderStep = (view: InstallView): readonly InstallStep[] => {
  switch (view.folder.kind) {
    case "folder":
      return [];
    case "missing":
      return [{ kind: "make-folder", path: view.link.folder }];
    case "link":
    case "other":
      return [
        {
          kind: "refuse",
          path: view.link.folder,
          reason: "is not a folder, and cannot be made one",
        },
      ];
  }
};

const linkStep = ({ link, at }: InstallView): InstallStep => {
  const { path, target } = link;
  if (at.kind === "link" && at.target === target) {
    return { kind: "keep-link", path, target };
  }
  if (at.kind === "link" && isOurs(at.target, link.mark)) {
    return { kind: "replace-link", path, target, previous: at.target };
  }
  const reason = notOurs(at);
  return reason === null
    ? { kind: "link", path, target }
    : { kind: "refuse", path, reason };
};

const viewSteps = (view: InstallView): readonly InstallStep[] =>
  view.target.kind === "missing"
    ? [
        {
          kind: "refuse",
          path: view.link.target,
          reason: "is missing from the package",
        },
      ]
    : [...folderStep(view), linkStep(view)];

/** Whether a step is the first of its folder to make. */
const firstOfItsFolder = (
  step: InstallStep,
  index: number,
  steps: readonly InstallStep[],
): boolean =>
  step.kind !== "make-folder" ||
  steps.findIndex(
    (other) => other.kind === "make-folder" && other.path === step.path,
  ) === index;

/**
 * The steps that install the links, in order: each link's folder made
 * when it is missing, then the link made, replaced when it is an older
 * one of this tool's, or kept when it is right. Any path that holds
 * something else is a refusal, and a plan with a refusal is not carried
 * out at all.
 */
export const planInstall = (
  views: readonly InstallView[],
): readonly InstallStep[] => views.flatMap(viewSteps).filter(firstOfItsFolder);

/** The plan's refusals: none, for a plan that may be carried out. */
export const refusals = (
  steps: readonly InstallStep[],
): readonly (InstallStep & { readonly kind: "refuse" })[] =>
  steps.flatMap((step) => (step.kind === "refuse" ? [step] : []));

/** What `uninstall` sees for one link. */
export type UninstallView = {
  readonly place: Place;
  readonly at: Entry;
};

export type UninstallStep =
  | {
      readonly kind: "remove-link";
      readonly path: string;
      readonly target: string;
    }
  | { readonly kind: "leave"; readonly path: string; readonly reason: string }
  | { readonly kind: "absent"; readonly path: string };

/**
 * The steps that uninstall: each link of this tool's removed, whichever
 * package it points into, and anything else left where it is. The folders
 * stay.
 */
export const planUninstall = (
  views: readonly UninstallView[],
): readonly UninstallStep[] =>
  views.map(({ place, at }): UninstallStep => {
    if (at.kind === "link" && isOurs(at.target, place.mark)) {
      return { kind: "remove-link", path: place.path, target: at.target };
    }
    const reason = notOurs(at);
    return reason === null
      ? { kind: "absent", path: place.path }
      : { kind: "leave", path: place.path, reason };
  });

/** One line telling a step of `install`. */
export const describeInstallStep = (step: InstallStep): string => {
  switch (step.kind) {
    case "make-folder":
      return `make folder ${step.path}`;
    case "link":
      return `link ${step.path} -> ${step.target}`;
    case "replace-link":
      return `replace link ${step.path} -> ${step.previous} with -> ${step.target}`;
    case "keep-link":
      return `keep link ${step.path} -> ${step.target}`;
    case "refuse":
      return `refuse: ${step.path} ${step.reason}`;
  }
};

/** One line telling a step of `uninstall`. */
export const describeUninstallStep = (step: UninstallStep): string => {
  switch (step.kind) {
    case "remove-link":
      return `remove link ${step.path} -> ${step.target}`;
    case "leave":
      return `leave ${step.path}: it ${step.reason}`;
    case "absent":
      return `nothing at ${step.path}`;
  }
};

/** How the user loads the extension in Chrome from its stable path, once. */
export const loadingInstructions = (extension: string): string =>
  `To load the extension in Google Chrome, once:
  1. Open chrome://extensions.
  2. Turn on "Developer mode", at the top right.
  3. Click "Load unpacked" and choose
     ${extension}
     In the file dialog, Command-Shift-G takes a typed path.
  4. Optionally, for file:// pages: open the extension's "Details" and turn
     on "Allow access to file URLs".
Then "declarative-tab-groups status" prints the versions of the command,
the extension and Google Chrome.
`;
