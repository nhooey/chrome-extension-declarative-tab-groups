// Where the host's socket is, and whether its folder is safe to serve
// from. Pure: the environment and a folder's metadata in, a path or a
// problem out. The command finds the socket with the same function.

import { dirname, isAbsolute, join } from "node:path";

import type { Result } from "../protocol/index.ts";
import { CLAIM_SUFFIX_BYTES } from "./claim.ts";

/** The variables `socketPath` reads, as `process.env` holds them. */
export type Environment = { readonly [name: string]: string | undefined };

/** The variable that names the socket's path, overriding the default. */
export const SOCKET_VARIABLE = "DECLARATIVE_TAB_GROUPS_SOCKET";

/**
 * The longest path macOS can bind or connect a Unix socket to, in bytes:
 * its `sun_path` holds 104 bytes, the last of them the terminating NUL.
 */
export const MAX_UNIX_SOCKET_PATH_BYTES = 103;

/** The longest socket path, leaving room for the claims beside it. */
export const MAX_SOCKET_PATH_BYTES =
  MAX_UNIX_SOCKET_PATH_BYTES - CLAIM_SUFFIX_BYTES;

/** A variable's value, or null when it is unset or empty, as `${NAME:-…}` reads it. */
const variable = (env: Environment, name: string): string | null => {
  const value = env[name];
  return value === undefined || value === "" ? null : value;
};

const pathFromEnvironment = (env: Environment): Result<string, string> => {
  const named = variable(env, SOCKET_VARIABLE);
  if (named !== null) {
    return isAbsolute(named)
      ? { ok: true, value: named }
      : { ok: false, error: `${SOCKET_VARIABLE} must be an absolute path` };
  }
  // The XDG base directory specification has a relative value ignored.
  const state = variable(env, "XDG_STATE_HOME");
  if (state !== null && isAbsolute(state)) {
    return { ok: true, value: join(state, "declarative-tab-groups/host.sock") };
  }
  const home = variable(env, "HOME");
  return home !== null && isAbsolute(home)
    ? {
        ok: true,
        value: join(home, ".local/state/declarative-tab-groups/host.sock"),
      }
    : {
        ok: false,
        error: `HOME must be an absolute path when neither ${SOCKET_VARIABLE} nor XDG_STATE_HOME is set`,
      };
};

/**
 * The socket's path: `DECLARATIVE_TAB_GROUPS_SOCKET` when it is set, else
 * `${XDG_STATE_HOME:-$HOME/.local/state}/declarative-tab-groups/host.sock`.
 * A path too long for a Unix socket is a problem, named with its length.
 */
export const socketPath = (env: Environment): Result<string, string> => {
  const path = pathFromEnvironment(env);
  if (!path.ok) {
    return path;
  }
  const bytes = new TextEncoder().encode(path.value).length;
  return bytes > MAX_SOCKET_PATH_BYTES
    ? {
        ok: false,
        error: `the socket path ${path.value} is ${bytes} bytes long; it may be at most ${MAX_SOCKET_PATH_BYTES}, since a Unix socket path on macOS holds at most ${MAX_UNIX_SOCKET_PATH_BYTES} and the host's claim beside it adds ${CLAIM_SUFFIX_BYTES}`,
      }
    : path;
};

/** The folder that holds the socket. */
export const socketFolder = (path: string): string => dirname(path);

/** What `lstat` tells of the socket's folder. */
export type FolderStatus = {
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly uid: number;
  readonly mode: number;
};

/** The bits that let the folder's group or others enter it. */
const ENTER_BY_OTHERS = 0o011;

/**
 * Why the host must not serve from this folder, or null when it may: it
 * must be a real folder, not a link to one, owned by the user `uid`, and
 * neither its group nor others may enter it.
 */
export const folderProblem = (
  folder: string,
  status: FolderStatus,
  uid: number,
): string | null =>
  status.isSymbolicLink || !status.isDirectory
    ? `${folder} is not a folder`
    : status.uid !== uid
      ? `${folder} belongs to another user`
      : (status.mode & ENTER_BY_OTHERS) !== 0
        ? `${folder} can be entered by other users; only its owner may enter it`
        : null;
