// The command's version: the package's, which `--version` and `status` print.

import packageJson from "../../package.json" with { type: "json" };

export const VERSION: string = packageJson.version;
