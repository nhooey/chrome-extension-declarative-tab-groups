// The command's `--help` texts, for the command and for each subcommand.

import { COLORS } from "../protocol/index.ts";

export const PROGRAM = "declarative-tab-groups";

const SUCCESS = "  0  success";

const REQUEST_FAILED = `  1  the request failed; error.code and error.message are on standard error`;

const SETUP_FAILED = `  1  install refused a path that holds something else, changing nothing;
     a step could not be carried out; or the system is not macOS`;

const REQUEST_STATUSES = `  2  usage error: a bad option, argument or URL, or an unusable socket path
  3  set succeeded, but kept open tabs that hold an unsubmitted form
  4  not connected: no host listens on the socket, none answers within 130
     seconds, or the host has no connection to the extension, as when
     Chrome is not running`;

const SETUP_USAGE = `  2  usage error: a bad option or argument, or a HOME that is not an
     absolute path`;

const EXIT_STATUSES = `Exit statuses:
${SUCCESS}
${REQUEST_FAILED}
${REQUEST_STATUSES}`;

const SETUP_EXIT_STATUSES = `Exit statuses:
${SUCCESS}
${SETUP_FAILED}
${SETUP_USAGE}`;

const ALL_EXIT_STATUSES = `Exit statuses:
${SUCCESS}
  1  failure: the request failed, with error.code and error.message on
     standard error; or install refused a path that holds something else,
     changing nothing; or a step of install or uninstall could not be
     carried out; or the system is not macOS
  2  usage error: a bad option, argument or URL, an unusable socket path,
     or a HOME that is not an absolute path
  3  set succeeded, but kept open tabs that hold an unsubmitted form
  4  not connected: no host listens on the socket, none answers within 130
     seconds, or the host has no connection to the extension, as when
     Chrome is not running`;

export const MAIN_HELP = `${PROGRAM}: set or read the tabs of a named Google Chrome tab group

Usage:
  ${PROGRAM} <command> [<option>...]
  ${PROGRAM} --help | --version

Commands:
  set         make a group hold exactly the given pages, in order
  get         print a group's pages, one URL per line
  status      print the versions of the command, the extension and Chrome
  install     link the native host and the extension for this user
  uninstall   remove those links

Options:
  -h, --help   print this help; "${PROGRAM} <command> --help" prints a
               command's own help
  --version    print the command's version

The commands set, get and status send one request to the native host on
its socket, $DECLARATIVE_TAB_GROUPS_SOCKET when that is set, else
\${XDG_STATE_HOME:-$HOME/.local/state}/declarative-tab-groups/host.sock,
wait at most 130 seconds for the answer, and print it. The command never
starts Chrome or any other program, and never retries.

${ALL_EXIT_STATUSES}

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

export const INSTALL_HELP = `${PROGRAM} install: link the native host and the extension for this user

Usage:
  ${PROGRAM} install [--dry-run]

Links two files of the package this command belongs to, found from the
command's own location, then prints how to load the extension in Chrome:

  - the native host's manifest, into
    ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/,
    where Google Chrome looks for it;
  - the unpacked extension, at
    \${XDG_DATA_HOME:-~/.local/share}/declarative-tab-groups/extension,
    a path that stays the same when the package is updated.

It makes a missing folder, replaces a link it made before, even one to an
older package, and keeps a link that is already right. When a path holds
anything else (a file, a folder, or a link that is not this tool's), it
says so and changes nothing. It never starts Chrome. macOS only.

Options:
  --dry-run    print each step and change nothing
  -h, --help   print this help

${SETUP_EXIT_STATUSES}

Example:
  ${PROGRAM} install --dry-run
`;

export const UNINSTALL_HELP = `${PROGRAM} uninstall: remove the links install made

Usage:
  ${PROGRAM} uninstall [--dry-run]

Removes the native host's manifest link and the extension's link, when
each is this tool's, to this package or another, and says what it leaves:
anything else at those paths stays. The folders stay too. Remove the
extension in chrome://extensions as well. macOS only.

Options:
  --dry-run    print each step and change nothing
  -h, --help   print this help

${SETUP_EXIT_STATUSES}

Example:
  ${PROGRAM} uninstall
`;
