// Where the package's files lie, relative to its root, and where they are
// linked for a user: Google Chrome's native-messaging folder, relative to
// the home folder, and the extension's stable path, relative to the data
// folder. Kept in `layout.json`, which the Home Manager module reads too.
// Pure.

import { EXTENSION_ORIGIN } from "../host/guard.ts";
import { NATIVE_HOST_NAME } from "../extension/identity.ts";
import layout from "./layout.json" with { type: "json" };

/** Each installed file's path under the package's root. */
export const PACKAGE_LAYOUT = layout.package;

/** Where a user's links go: `hostManifests` under the home folder, `extension` under the data folder. */
export const HOME_LAYOUT = layout.home;

/** The host manifest's file name, which Chrome finds the host by. */
export const HOST_MANIFEST_FILE = `${NATIVE_HOST_NAME}.json`;

/** The host manifest's path under the package's root. */
export const PACKAGE_HOST_MANIFEST = `${PACKAGE_LAYOUT.hostManifests}/${HOST_MANIFEST_FILE}`;

/**
 * The package's root, from the command's real path: null when the command
 * runs from anywhere but its place in a package, as from the sources.
 */
export const packageRootOf = (entry: string): string | null => {
  const suffix = `/${PACKAGE_LAYOUT.command}`;
  return entry.endsWith(suffix) ? entry.slice(0, -suffix.length) : null;
};

export type HostManifest = {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly type: "stdio";
  readonly allowed_origins: readonly string[];
};

/** The host's manifest, for a package whose host program is at the absolute path `hostPath`. */
export const hostManifest = (hostPath: string): HostManifest => ({
  name: NATIVE_HOST_NAME,
  description:
    "declarative-tab-groups: relays requests between a Unix socket and the extension",
  path: hostPath,
  type: "stdio",
  allowed_origins: [EXTENSION_ORIGIN],
});
