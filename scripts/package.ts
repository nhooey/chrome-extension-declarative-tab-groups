// Lays out the package in a folder, from what `npm run build` wrote: the
// unpacked extension, the command and the host with their links in bin/
// and libexec/, and the host's manifest, which names the host by its
// absolute path. The Nix package's install phase runs it on $out; a test
// runs it on a folder of its own.

import { constants } from "node:fs";
import { chmod, cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import {
  hostManifest,
  PACKAGE_HOST_MANIFEST,
  PACKAGE_LAYOUT,
} from "../src/command/layout.ts";

/** u=rwx,go=rx, for the programs and the folders made for them. */
const MODE =
  constants.S_IRWXU |
  constants.S_IRGRP |
  constants.S_IXGRP |
  constants.S_IROTH |
  constants.S_IXOTH;

/** Each program's path in the package, and its link there. */
const PROGRAMS = [
  { file: PACKAGE_LAYOUT.command, link: PACKAGE_LAYOUT.commandLink },
  { file: PACKAGE_LAYOUT.host, link: PACKAGE_LAYOUT.hostLink },
] as const;

/** Writes the package into `out` from `dist`, the folder `npm run build` writes. */
export const layOutPackage = async (
  outPath: string,
  dist: string,
): Promise<void> => {
  const out = resolve(outPath);
  const at = (path: string): string => join(out, path);
  const makeFolderOf = (path: string): Promise<string | undefined> =>
    mkdir(dirname(at(path)), { recursive: true, mode: MODE });

  await makeFolderOf(PACKAGE_LAYOUT.extension);
  await cp(join(dist, "extension"), at(PACKAGE_LAYOUT.extension), {
    recursive: true,
  });
  for (const { file, link } of PROGRAMS) {
    await makeFolderOf(file);
    await cp(join(dist, "programs", basename(file)), at(file));
    await chmod(at(file), MODE);
    await makeFolderOf(link);
    await symlink(relative(dirname(at(link)), at(file)), at(link));
  }
  await makeFolderOf(PACKAGE_HOST_MANIFEST);
  await writeFile(
    at(PACKAGE_HOST_MANIFEST),
    `${JSON.stringify(hostManifest(at(PACKAGE_LAYOUT.hostLink)), null, 2)}\n`,
  );
};

if (import.meta.main) {
  const [out, dist = "dist"] = process.argv.slice(2);
  if (out === undefined) {
    throw new Error("usage: node scripts/package.ts <out> [<dist>]");
  }
  await layOutPackage(out, dist);
}
