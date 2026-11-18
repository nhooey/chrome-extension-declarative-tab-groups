# declarative-tab-groups

A Manifest V3 Google Chrome extension, a native-messaging host and a command, `declarative-tab-groups`, that let any local program set the exact tabs of a named Chrome tab group: the program gives the group's title and an ordered list of URLs, and the group then holds exactly those pages, in that order, with no window raised or focused. It is for Google Chrome on macOS only.

A program can run the command, or talk to the host directly by [the protocol](docs/protocol.md).

## What it guarantees

- **It never takes focus.** No window is raised or focused, and no requested page becomes the active tab. The one tab it ever makes active is the group's [status page](#the-status-page), and only in place of an active tab the request closes.
- **Google Chrome only.** The extension does nothing in any other browser, Chromium-based ones such as Brave included, and the host serves only stable Google Chrome; see [the Chrome-only guards](#the-chrome-only-guards).
- **Unsubmitted forms are kept.** A tab whose page holds text the user typed and has not submitted, such as a half-written comment, stays open, and the response lists it.
- **The group never disappears.** Chrome deletes a group when its last tab closes; a request always leaves the group a tab while its pages are replaced, and an emptied group holds a page of the extension's that names it.

## Requirements

- macOS.
- Google Chrome 126 or later, the stable channel.
- Nix, with flakes, to build and install the package.

## Installing

The package holds the command, `bin/declarative-tab-groups`; the native host, `libexec/declarative-tab-groups-host`, which only Chrome runs; the host's manifest, which tells Chrome where the host is and which extension may start it; and the unpacked extension. Installing links two of them for the user:

- the host's manifest into `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`, where Google Chrome looks for it;
- the unpacked extension at `${XDG_DATA_HOME:-~/.local/share}/declarative-tab-groups/extension`, a path that stays the same when the package is updated.

Then the extension is loaded in Chrome once, by hand, as [Loading the extension](#loading-the-extension) shows.

### With Home Manager

Add the flake as an input, import its module, and enable it:

```nix
{
  inputs.declarative-tab-groups.url = "github:nhooey/chrome-extension-declarative-tab-groups";

  # In the Home Manager configuration:
  imports = [ inputs.declarative-tab-groups.homeManagerModules.default ];
  programs.declarative-tab-groups.enable = true;
}
```

The module puts the command in `home.packages` and makes the two links through `home.file`. `programs.declarative-tab-groups.package` chooses another build of the package; it defaults to the flake's own. The module asserts that the system is macOS.

### Without Home Manager

Install the package into a Nix profile, look at what `install` will do, then do it:

```sh
nix profile install github:nhooey/chrome-extension-declarative-tab-groups
declarative-tab-groups install --dry-run
declarative-tab-groups install
```

`install` finds the package's files from the command's own location, not from `PATH`. It makes a missing folder with mode `u=rwx,go=rx`, replaces a link it made before, even one to an older package, and keeps a link that is already right. When a path it needs holds anything else (a file, a folder, or a link that is not this tool's, such as one Home Manager made), it names the path, changes nothing and exits 1. It never starts Chrome and never needs it running.

The links point into the package's own folder in the Nix store, so run `declarative-tab-groups install` again after each update of the package: it moves the links to the new package.

### Loading the extension

Once, in Google Chrome:

1. Open `chrome://extensions`.
2. Turn on **Developer mode**, at the top right.
3. Click **Load unpacked** and choose `~/.local/share/declarative-tab-groups/extension`, or the same folder under `$XDG_DATA_HOME` when that is set. In the file dialog, Command-Shift-G takes a typed path.
4. Optionally, for `file://` pages: open the extension's **Details** and turn on **Allow access to file URLs**. While it is off, a request with a `file://` URL fails with `invalid-request` and changes nothing.

The extension's ID is `hgooabdnifmafojdaabifdnombnflfii`, the one ID the host's manifest allows. Within about 30 seconds the extension connects to the host, and `declarative-tab-groups status` answers.

## Using the command

`declarative-tab-groups` sends one request to the host's socket, waits at most 130 seconds for the response, and prints it; `--json` prints the response exactly as the host sent it, or, when no host answers, the `not-connected` failure the command makes in its place. It never starts Chrome and never retries. `declarative-tab-groups <command> --help` describes each command's options.

Make the group "Reading" hold two pages, in a blue group:

```sh
declarative-tab-groups set --group Reading --color blue https://example.com/ https://example.org/
```

Give the pages one per line on standard input, or in a file with `--urls-from <file>`, and open an unfocused window for the group when it is new and no window can hold it:

```sh
printf '%s\n' https://example.com/ https://example.org/ | declarative-tab-groups set --group Reading --create-window --urls-from -
```

Print the group's pages, one URL per line, then empty it:

```sh
declarative-tab-groups get --group Reading
declarative-tab-groups set --group Reading
```

Print the versions of the command, the extension and Google Chrome, which shows that the whole path works:

```sh
declarative-tab-groups status
```

| Exit status | Meaning                                                                                                                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0           | Success.                                                                                                                                                                                                                                 |
| 1           | Failure: the request failed, with `error.code` and `error.message` on standard error; or `install` refused a path that holds something else, changing nothing; or a step of `install` or `uninstall` failed; or the system is not macOS. |
| 2           | A usage error: a bad option, argument or URL, an unusable socket path, or a `HOME` that is not an absolute path.                                                                                                                         |
| 3           | `set` succeeded, but kept open tabs that hold an unsubmitted form.                                                                                                                                                                       |
| 4           | Not connected: no host listens on the socket, none answers within 130 seconds, or the host has no connection to the extension.                                                                                                           |

## Using the protocol from another program

A program that does not run the command connects to the host's Unix socket, `${XDG_STATE_HOME:-$HOME/.local/state}/declarative-tab-groups/host.sock`, or `$DECLARATIVE_TAB_GROUPS_SOCKET` when that is set, and sends one JSON request per line; each gets one JSON response line. [The protocol reference](docs/protocol.md) gives every request, response and error code, with examples.

## The extension

The extension's service worker connects to the native host and carries out each request on Chrome's tab strip: it reads the named group, closes the pages that should go, opens the requested ones, and answers with what it did. A tab holding a form the user has not submitted stays open.

It never focuses or raises a window, and every tab it opens is a background tab: it never makes a requested page the active tab. When a request closes the tab that is active in its window, its group's [status page](#the-status-page) takes that tab's place while the status page is on; while it is off, Chrome itself picks the window's next active tab, which may be one of the new pages. It runs only in Google Chrome, and not in incognito windows; in any other browser, Chromium-based ones included, it does nothing at all.

## The status page

Each group the extension sets holds the extension's status page as its first tab. The page shows what the extension is doing to the group:

- **While a request runs:** a checklist of its steps (checking the tabs for unsubmitted forms, closing, opening each URL, waiting for the pages to load), with a line for each tab or URL that changes state as the step goes.
- **Once the group is ready:** the group's title, how many pages it holds or that it is empty, and when it was last set, above the finished checklist of the latest request, which stays until the next request starts.

So no page of a request needs to become the active tab to show that something happened, and the group keeps a tab while its other pages are replaced.

The status page is on unless it is turned off:

- **For every group:** the extension's options page has one checkbox for it, on by default.
- **For one request:** the request's `statusPage` field, `true` or `false`, overrides that setting; the command's `--status-page` and `--no-status-page` set it.

With it off, the group holds only the request's pages, a request closes a status page the group already has, and an empty group holds a plain page of the extension's own, which names the group.

Each page of the extension's own names its group. A request closes any that names another group, such as one opened before the group was renamed or dragged in from another group. It opens the group's own status page when the status page is on and the group lacks one, and the group's own empty page only when the status page is off and the group would otherwise hold nothing. A request that never finished, because its deadline passed or the extension's service worker stopped, shows on the status page as failed.

The status page is the only tab the extension ever makes active, and only when the window's active tab is one the request is about to close: the status page then takes its place, where Chrome would otherwise make a neighbouring tab active. Nothing is made active when the active tab is outside the group, is kept for its unsubmitted form, or is not being closed.

## The host

Google Chrome starts the native-messaging host, `libexec/declarative-tab-groups-host` in the package, when the extension connects to it, and the host relays requests between a Unix socket and the extension. The socket is `$DECLARATIVE_TAB_GROUPS_SOCKET` when that is set, else `${XDG_STATE_HOME:-$HOME/.local/state}/declarative-tab-groups/host.sock`, in a folder only the user can enter. When several hosts start at once, as when more than one Chrome profile has the extension, at most one serves, and the others refuse with `socket-in-use`.

## The Chrome-only guards

Three checks keep every other browser out:

- **The extension** reads the browser's brand list when its service worker starts, and does nothing at all unless the list names Google Chrome.
- **The host** looks up the executable of the process that started it, the browser's main process, and serves only when that is stable Google Chrome, `…/Google Chrome.app/Contents/MacOS/Google Chrome`; otherwise it answers `not-google-chrome` and exits. It serves only this tool's extension, whose origin Chrome passes it.
- **Installing** writes only Google Chrome's native-messaging folder, `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`.

Brave, among other browsers, reads Google Chrome's native-messaging folder too, so the manifest being there does not keep Brave from starting the host: the host's check of its parent is what refuses it.

## When `status` finds something missing

`declarative-tab-groups status` exits 0 and prints the three versions only when the command, the socket, the host and the extension all work. Otherwise it exits 4 with a `not-connected` line on standard error:

- **`no host answers on <socket>`:** no host serves the socket. Chrome is not running; or the host's manifest is not linked, which `declarative-tab-groups install --dry-run` shows as a `link` step where it would show `keep link`; or the extension is not loaded, or is turned off, at `chrome://extensions`; or the browser that has it is not Google Chrome. The extension connects within about 30 seconds of Chrome starting or of the host stopping.
- **`the host at <socket> did not answer within 130 seconds`:** a host took the request, but no answer came.
- **`Chrome closed the connection to the extension before it answered`:** Chrome ended the extension's connection to the host mid-request, as when Chrome quits.

When a second Chrome profile has the extension too, its host refuses with `socket-in-use`, and the first profile's host serves. The extension's service worker logs each refusal in its console, which **Inspect views: service worker** on its card at `chrome://extensions` opens.

## Uninstalling

Without Home Manager, remove the links:

```sh
declarative-tab-groups uninstall --dry-run
declarative-tab-groups uninstall
```

`uninstall` removes each of the two links that is this tool's, to this package or an older one, and leaves anything else at those paths, saying so; the folders stay. Then click **Remove** on the extension's card at `chrome://extensions`, and remove the package with `nix profile remove`, naming the element `nix profile list` shows.

With Home Manager, set `programs.declarative-tab-groups.enable = false` or remove the module, switch, and remove the extension in Chrome.

## Checks by hand

No automated test drives a real Chrome. [Checks by hand](docs/checks-by-hand.md) lists the behaviours only a person at Chrome can confirm, each as a step to do and the result to expect.
