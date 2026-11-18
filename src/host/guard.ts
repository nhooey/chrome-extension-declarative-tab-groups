// The two checks the host makes before it serves: that its parent, the
// browser's main process, is Google Chrome, and that the extension calling
// it is this tool's. Pure predicates; `host.ts` looks up the parent.
//
// The parent check is what keeps other browsers out: Brave, among others,
// reads Google Chrome's native-messaging folder on macOS, so the host's
// manifest being there proves nothing about the browser that started it.

import { EXTENSION_ID } from "../extension/identity.ts";

/** How the path of stable Google Chrome's main executable ends on macOS. */
export const GOOGLE_CHROME_EXECUTABLE_SUFFIX =
  "/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * Whether the parent's executable path, as `ps -o comm=` prints it, is
 * stable Google Chrome's. A failed lookup (null) or an empty path is not.
 */
export const isGoogleChromeExecutable = (path: string | null): boolean =>
  path !== null && path.endsWith(GOOGLE_CHROME_EXECUTABLE_SUFFIX);

/** The origin Chrome passes the host when this tool's extension starts it. */
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;

/** Whether the host's first argument is exactly this tool's extension's origin. */
export const isExtensionOrigin = (argument: string | undefined): boolean =>
  argument === EXTENSION_ORIGIN;
