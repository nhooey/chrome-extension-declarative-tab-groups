// The `declarative-tab-groups` command's entry point.

import { RESPONSE_DEADLINE_MS, runCommand } from "./run.ts";

// Set rather than passed to `process.exit`, so output still on its way to
// a pipe is written before the process ends.
process.exitCode = await runCommand({
  args: process.argv.slice(2),
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  deadlineMs: RESPONSE_DEADLINE_MS,
});
