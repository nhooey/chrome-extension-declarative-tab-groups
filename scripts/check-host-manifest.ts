// Checks the host manifest of a built package: JSON, named as the extension
// connects to the host, its `path` the package's own executable host, and
// its `allowed_origins` exactly this tool's extension. The flake's
// `programs` check runs it on the package, as
// `node scripts/check-host-manifest.ts <package>`.

import { isDeepStrictEqual } from "node:util";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  PACKAGE_HOST_MANIFEST,
  PACKAGE_LAYOUT,
} from "../src/command/layout.ts";
import { NATIVE_HOST_NAME } from "../src/extension/identity.ts";
import { EXTENSION_ORIGIN } from "../src/host/guard.ts";

const FIELDS = ["name", "description", "path", "type", "allowed_origins"];

const isRecord = (
  value: unknown,
): value is { readonly [key: string]: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** What is wrong with a manifest's text, for a host at `hostPath`: nothing, for a right one. */
export const hostManifestProblems = (
  text: string,
  hostPath: string,
): readonly string[] => {
  const manifest = parsed(text);
  if (!isRecord(manifest)) {
    return ["it is not a JSON object"];
  }
  const check = (ok: boolean, problem: string): readonly string[] =>
    ok ? [] : [problem];
  const description = manifest["description"];
  return [
    ...check(
      isDeepStrictEqual(Object.keys(manifest).toSorted(), FIELDS.toSorted()),
      `its fields are ${Object.keys(manifest).join(", ")}, not ${FIELDS.join(", ")}`,
    ),
    ...check(
      manifest["name"] === NATIVE_HOST_NAME,
      `its name is ${JSON.stringify(manifest["name"])}, not ${JSON.stringify(NATIVE_HOST_NAME)}`,
    ),
    ...check(
      typeof description === "string" && description !== "",
      "it has no description",
    ),
    ...check(
      manifest["path"] === hostPath,
      `its path is ${JSON.stringify(manifest["path"])}, not ${JSON.stringify(hostPath)}`,
    ),
    ...check(
      manifest["type"] === "stdio",
      `its type is ${JSON.stringify(manifest["type"])}, not "stdio"`,
    ),
    ...check(
      isDeepStrictEqual(manifest["allowed_origins"], [EXTENSION_ORIGIN]),
      `its allowed_origins are ${JSON.stringify(manifest["allowed_origins"])}, not ${JSON.stringify([EXTENSION_ORIGIN])}`,
    ),
  ];
};

/** What is wrong with the host manifest of the package at `root`, and with the host it names. */
export const packageProblems = async (
  root: string,
): Promise<readonly string[]> => {
  const hostPath = join(root, PACKAGE_LAYOUT.hostLink);
  const manifest = join(root, PACKAGE_HOST_MANIFEST);
  const host = await access(hostPath, constants.X_OK)
    .then(() => stat(hostPath))
    .then(
      (status) => (status.isFile() ? [] : [`${hostPath} is not a file`]),
      () => [`${hostPath} is not an executable file`],
    );
  const text = await readFile(manifest, "utf8").catch(() => null);
  return [
    ...host,
    ...(text === null
      ? [`${manifest} cannot be read`]
      : hostManifestProblems(text, hostPath).map(
          (problem) => `${manifest}: ${problem}`,
        )),
  ];
};

if (import.meta.main) {
  const root = process.argv[2];
  const problems =
    root === undefined
      ? ["usage: node scripts/check-host-manifest.ts <package>"]
      : await packageProblems(root);
  problems.forEach((problem) => console.error(problem));
  process.exitCode = problems.length === 0 ? 0 : 1;
}
