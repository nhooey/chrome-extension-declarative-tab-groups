// The command's `--help` texts, for the command and for each subcommand.

import { COLORS } from "../protocol/index.ts";

export const PROGRAM = "declarative-tab-groups";

const EXIT_STATUSES = `Exit statuses:
  0  success
  1  the request failed; error.code and error.message are on standard error
  2  usage error: a bad option, argument or URL, or an unusable socket path
  3  set succeeded, but kept open tabs that hold an unsubmitted form
  4  not connected: no host listens on the socket, none answers within 130
     seconds, or the host has no connection to the extension, as when
     Chrome is not running`;

export const MAIN_HELP = `${PROGRAM}: set or read the tabs of a named Google Chrome tab group

Usage:
  ${PROGRAM} <command> [<option>...]
  ${PROGRAM} --help | --version

Commands:
  set      make a group hold exactly the given pages, in order
  get      print a group's pages, one URL per line
  status   print the versions of the command, the extension and Chrome

Options:
  -h, --help   print this help; "${PROGRAM} <command> --help" prints a
               command's own help
  --version    print the command's version

The command sends one request to the native host on its socket,
$DECLARATIVE_TAB_GROUPS_SOCKET when that is set, else
\${XDG_STATE_HOME:-$HOME/.local/state}/declarative-tab-groups/host.sock,
waits at most 130 seconds for the answer, and prints it. It never starts
Chrome or any other program, and never retries.

${EXIT_STATUSES}

Example:
  ${PROGRAM} set --group Reading https://example.com/ https://example.org/
`;

export const SET_HELP = `${PROGRAM} set: make a named tab group hold exactly the given pages

Usage:
  ${PROGRAM} set --group <title> [<option>...] [<url>...]

The group then holds one fresh tab per URL, in order, after its status page
when that is on. No window is raised or focused and no new tab is made
active. With no URL the group is emptied. A tab holding a form the user has
not submitted is kept open, and listed.

Options:
  --group <title>      the group's title, matched exactly (required)
  --color <colour>     the group's colour: ${COLORS.join(", ")}
  --create-window      when the group is new and no window can hold it, open
                       one for it, unfocused, instead of failing
  --status-page        show the group's status page for this request
  --no-status-page     leave it out; with neither, the extension's setting
                       decides
  --urls-from <file>   read the URLs one per line from <file>, or from
                       standard input when <file> is -; blank lines are
                       ignored; not together with <url> arguments
  --json               print the response exactly as the host sent it; when
                       no host answers, the not-connected failure the
                       command makes in its place
  -h, --help           print this help

Each URL begins with http://, https:// or file://.

${EXIT_STATUSES}

Example:
  printf '%s\\n' https://example.com/ https://example.org/ |
    ${PROGRAM} set --group Reading --color blue --urls-from -
`;

export const GET_HELP = `${PROGRAM} get: print a named tab group's pages

Usage:
  ${PROGRAM} get --group <title> [--json]

Prints the URL of each of the group's tabs, one per line, in order, without
the extension's own pages.

Options:
  --group <title>   the group's title, matched exactly (required)
  --json            print the response exactly as the host sent it; when no
                    host answers, the not-connected failure the command
                    makes in its place
  -h, --help        print this help

${EXIT_STATUSES}

Example:
  ${PROGRAM} get --group Reading
`;

export const STATUS_HELP = `${PROGRAM} status: print the versions of the command, the extension and Chrome

Usage:
  ${PROGRAM} status [--json]

An answer shows that the whole path, from the socket through the host to the
extension, works.

Options:
  --json        print the response exactly as the host sent it; when no host
                answers, the not-connected failure the command makes in its
                place
  -h, --help    print this help

${EXIT_STATUSES}

Example:
  ${PROGRAM} status
`;
