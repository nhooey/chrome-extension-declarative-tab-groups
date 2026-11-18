// Who the extension is to Chrome and to its native host: the host's name,
// which the service worker connects to, and the extension's ID, which the
// host's manifest names in `allowed_origins`. Both are kept in
// `identity.json`, which the Home Manager module reads too.

import identity from "./identity.json" with { type: "json" };

/** The native-messaging host's name, as `chrome.runtime.connectNative` takes it. */
export const NATIVE_HOST_NAME: string = identity.nativeHostName;

/** The extension's ID, fixed by `key` in manifest.json; a test derives it from the key. */
export const EXTENSION_ID: string = identity.extensionId;

/** One hexadecimal digit, 0 to 15, written as Chrome writes it in an ID: `a` to `p`. */
const idDigit = (nibble: number): string => String.fromCharCode(0x61 + nibble);

/** The ID Chrome gives a key whose SHA-256 digest is `digest`: its first 16 bytes, each hex digit written `a` to `p`. */
export const extensionIdFromDigest = (digest: Uint8Array): string =>
  Array.from(digest.subarray(0, 16))
    .map((byte) => idDigit(byte >> 4) + idDigit(byte & 0x0f))
    .join("");

/** The ID of the extension whose manifest `key` is this base64 DER public key. */
export const extensionIdFromKey = async (key: string): Promise<string> => {
  const der = Uint8Array.from(atob(key), (character) =>
    character.charCodeAt(0),
  );
  return extensionIdFromDigest(
    new Uint8Array(await crypto.subtle.digest("SHA-256", der)),
  );
};
