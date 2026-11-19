// The native-messaging host's entry point, which Chrome starts with the
// calling extension's origin as its argument. Its parent process is the
// browser's main process, found with `/bin/ps`; the host serves only when
// that is Google Chrome. Nothing switches that check off.

import { execFile } from "node:child_process";
import { endianness } from "node:os";

import { processIo, run } from "./host.ts";

/** The executable path of this process's parent, as `ps -o comm=` prints it. */
const parentExecutable = (): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(
      "/bin/ps",
      ["-o", "comm=", "-p", String(process.ppid)],
      (error, stdout) => {
        resolve(
          error === null
            ? stdout.endsWith("\n")
              ? stdout.slice(0, -1)
              : stdout
            : null,
        );
      },
    );
  });

process.exit(await run(processIo(parentExecutable, endianness())));
