// Writes the unpacked extension into one folder: manifest.json, the
// bundled service worker, and the empty page, the status page with its
// stylesheet and the options page, each with its bundled script. `npm run
// build` writes it to dist/extension/; a test builds it into a folder of
// its own.

import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const source = (name: string): string =>
  fileURLToPath(new URL(`../src/extension/${name}`, import.meta.url));

/** The files copied as they are. */
const STATIC_FILES = [
  "manifest.json",
  "empty.html",
  "status.html",
  "status.css",
  "options.html",
] as const;

/** Each bundle's name in the output folder, and its entry point. */
const BUNDLES = {
  "service-worker": "background.ts",
  empty: "empty.ts",
  status: "status.ts",
  options: "options.ts",
} as const;

/** The oldest Chrome the bundles must run in: manifest.json's `minimum_chrome_version`. */
const TARGET = "chrome126";

export const buildExtension = async (outDir: string): Promise<void> => {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await build({
    entryPoints: Object.fromEntries(
      Object.entries(BUNDLES).map(([name, entry]) => [name, source(entry)]),
    ),
    outdir: outDir,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: TARGET,
    logLevel: "warning",
  });
  await Promise.all(
    STATIC_FILES.map((name) => copyFile(source(name), join(outDir, name))),
  );
};

if (import.meta.main) {
  await buildExtension(process.argv[2] ?? "dist/extension");
}
