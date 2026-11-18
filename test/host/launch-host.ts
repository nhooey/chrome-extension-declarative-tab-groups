// A test-only launcher: the host's `run` with a parent lookup that answers
// Google Chrome's path, so a test can stand in for Chrome on the host's
// pipes. The real entry point, `src/host/main.ts`, always asks `/bin/ps`.
// A test may shorten the wait for the extension's answer by putting
// `--request-timeout-ms <n>` ahead of the origin.

import { endianness } from "node:os";

import { processIo, run } from "../../src/host/host.ts";
import { REQUEST_TIMEOUT_MS } from "../../src/host/router.ts";

const GOOGLE_CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const args = process.argv.slice(2);
const shortened = args[0] === "--request-timeout-ms";
const io = processIo(
  async () => GOOGLE_CHROME,
  endianness(),
  shortened ? Number(args[1]) : REQUEST_TIMEOUT_MS,
);

process.exit(await run({ ...io, args: shortened ? args.slice(2) : args }));
