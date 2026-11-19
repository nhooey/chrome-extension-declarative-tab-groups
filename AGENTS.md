# declarative-tab-groups

A Google Chrome extension, a native-messaging host and a command, `declarative-tab-groups`, that let any local program set a named tab group's exact tabs without taking focus, on macOS.

## Layout

- `flake.nix`: the package, the dev shell, the formatter and the checks.
- `nix/run-npm-script.sh`: the build command of the checks that run an npm script.
- `nix/check-programs.sh`: the build command of the `programs` check, which runs the installed command's `--help` and `--version` and sees the installed host refuse outside Google Chrome.
- `package.json`, `package-lock.json`: the Node package, written in TypeScript that Node runs by stripping its types. Its dependencies are all for development: TypeScript, Node's and Chrome's types, and esbuild, which bundles the extension, the host and the command.
- `tsconfig.base.json` and the projects that extend it, so each part is type-checked against only the APIs it may use:
  - `tsconfig.json`: the tests and `scripts/`, with Node's types.
  - `src/protocol/tsconfig.json`: the protocol module, with the Web APIs and neither Node's nor Chrome's.
  - `src/extension/tsconfig.json`: the extension, with the Web APIs and Chrome's types, and not Node's.
  - `src/host/tsconfig.json` and `src/command/tsconfig.json`: the host and the command, with Node's types.
- `scripts/build.ts`: `buildExtension`, which writes the unpacked extension into one folder, and `buildPrograms`, which bundles the command and the host into one `.mjs` file each, with a `#!` line for Node.
- `src/protocol/`: the protocol module the extension, the host and the command share. It is pure functional TypeScript, with no I/O and no Node or Chrome API, and `index.ts` exports all of it.
- `test/protocol/`: its tests, under `node --test` with `node:test` and `node:assert/strict`; `docs.test.ts` parses every `json` example of `docs/protocol.md`.
- `src/extension/`: the extension. Only the entry points, `background.ts`, `status.ts` and `options.ts`, name the `chrome` global; every other module takes Chrome as a parameter, so the tests run it against fakes.
  - `manifest.json`: the Manifest V3 manifest, not allowed in incognito windows. Its `key`, the public half of an RSA key whose private half exists nowhere, fixes the extension's ID; an unpacked extension needs no private key.
  - `identity.ts`: `NATIVE_HOST_NAME`, the native host's name, `EXTENSION_ID`, and `extensionIdFromKey`, which derives the ID from a key as Chrome does.
  - `browser.ts`: `isGoogleChrome`, true only for a brand list naming "Google Chrome", and `chromeVersion`.
  - `tab-strip.ts`: `TabStrip`, the narrowed interface through which the extension reaches Chrome's tabs, windows, groups and scripts, and whether it may open file URLs. It names exactly the Chrome operations used, none of which can focus a window: there is no `windows.update` or `tabs.highlight`, `tabs.create` takes only `active: false`, `windows.create` only `focused: false`, and `tabs.update` only `{ active: true }`, which the extension calls for its status page alone. `narrowTabStrip` keeps only those operations of Chrome, and passes Chrome only the fields the interface names; its `scripting.executeScript` takes no function and always injects the form check, `hasUnsubmittedForm`. Beside it, `Clock`, through which all waiting goes, `within`, which bounds a wait by the clock, and `Edge`, the two with the extension's page URLs and the signal that aborts when a request is given up.
  - `state.ts`: what the planner knows of Chrome: the groups, each tab's kind (the group's status page, its empty page, a `stray` page of the extension's naming another group, which always closes, or another page) and form state, each group's window's active tab, the window a new group goes in, and whether the status page is on.
  - `read-state.ts`: `readGroupState`, which reads that state and reports the form check as it runs, `tabKind`, which tells the extension's own pages by their URL, `groupTabKind`, which counts one as a group's own only when its `group` query names that group, `groupsTitled`, the groups of normal windows with an exact title, and `activeTabOf`, a window's active tab. A discarded, frozen or unloaded tab is `unchecked` without the form check, and a form check that has not answered in 5 seconds is `unchecked` too.
  - `steps.ts`: the steps a plan is made of, as plain data, and `STEP_KINDS`, every kind of step; none focuses a window, and only `activate-status-page` makes a tab active. A tab the plan opens is named by its role and position, since it has no id yet.
  - `plan.ts`: `plan`, which turns the state and a `set` request into the ordered steps and what the response reports, or a failure. It activates the status page only when it closes the window's active tab and the status page is on, after the status page is in the group and before anything closes.
  - `run-plan.ts`: `runPlan`, which carries out the steps in order, reports each close, open and load as it starts and ends, and answers the `set` request. A new tab opens at the window's end and is then put in its place by the group's tabs as read just before, so a tab added meanwhile cannot disorder the pages. A tab to close that has gone meanwhile is skipped. A change Chrome refuses while the user drags a tab is tried again for 5 seconds, then answered with `busy`; the opened pages are waited for up to 30 seconds. It activates the status page only while the tab it replaces is still active, and only a tab that is still the group's own status page, in the plan's window and group.
  - `settings.ts`: the one setting, whether a group holds the status page, read from `chrome.storage.local` through `SettingsStorage`, and `statusPageWanted`, the request's `statusPage` over that setting.
  - `progress.ts`: `advance`, the pure fold of the events a `set` request emits into a group's progress: the request under way as stages of lines, and the latest finished request as the log.
  - `progress-store.ts`: `ProgressStorage`, the narrowed `chrome.storage.session` that holds each group's progress, `readProgress`, `progressReport`, the report a request's steps are told through, which writes the progress after each event until the request's end and never waits on the storage, and `interruptedProgress` with its edge `endInterrupted`, which end the requests a stopped service worker left under way.
  - `view.ts`: `view`, which turns a group's progress into the status page's tree of labelled lines.
  - `status-dom.ts`: `drawStatus`, which draws that tree into the page as text, keeping the element of each line it already shows.
  - `form-check.ts`: `hasUnsubmittedForm`, which Chrome serialises and runs in every frame of a tab, so it imports and closes over nothing, and `tabFormState`, which folds a tab's frame results into `clean`, `unsubmitted` or `unchecked`.
  - `commands.ts`: `handleRequest`, the answer to `set`, `get` and `status`, which never throws and answers `internal` after 90 seconds, then aborts the request's signal so its run, checking it before each step, retry, poll and read, calls Chrome no more once the call under way returns, and `queueKey`, the queue each request waits in. A `set` with a file URL fails with `invalid-request`, before any change, while the user has not allowed the extension file URLs. A `set` reports its start, its plan and its outcome to the group's progress, and one answered at the deadline reports that failure as its end.
  - `queue.ts`: `queueByKey`, which runs the requests on one group one at a time, in arrival order, with at most 100 waiting; the worker answers one more with `busy`.
  - `connection.ts`: the native port's `transition`, a pure function from the connection's state and an event to its next state and the effects to carry out. A port whose host sends no hello in 10 seconds is dropped, and the alarm retries.
  - `service-worker.ts`: `startServiceWorker`, the edge that carries out those effects and holds the port, the connection's state and the queue. Before it handles a request it ends the requests a stopped worker left under way, waiting up to 5 seconds on the storage. Outside Google Chrome it does nothing at all.
  - `background.ts`: the service worker's entry point, which hands Chrome to `startServiceWorker`.
  - `empty.html` and `empty.ts`: the page an empty group holds while the status page is off, naming the group from its `?group=` query.
  - `status.html`, `status.css` and `status.ts`: the status page, a group's first tab while it is on. Its script reads the progress of the group its `?group=` query names and draws it again on every `chrome.storage.onChanged`; its stylesheet holds all its motion, which `prefers-reduced-motion` turns off.
  - `options.html` and `options.ts`: the options page, one checkbox for the status-page setting.
- `test/extension/`: their tests. `simulate.ts` applies a plan's steps to a model of the group and `generate.ts` makes seeded states and requests, for the properties `plan-properties.test.ts` checks; `form-check.test.ts` runs the form check from its source in a `node:vm` context whose global is a fake window; `fake-chrome.ts` is an in-memory Chrome behind `TabStrip` that records every call, with fake storage areas that can refuse or never answer, which the `set`, `get`, never-focus and status-page tests run against; `status-dom.test.ts` draws the status page into a fake document.
- `src/host/`: the native-messaging host, which Chrome starts and which relays between its port and the Unix socket. Its logic is pure; `host.ts` and `main.ts` are the edges.
  - `frame.ts`: `encodeFrame` and `decodeFrames`, Chrome's length-prefixed framing; a declared length over 64 MiB is an error.
  - `lines.ts`: `splitLines` and `finishLines`, the socket's lines with a bound on a line's length; the command reads its response with them too.
  - `socket-path.ts`: `socketPath`, the socket's path from the environment, which the command shares, and `folderProblem`, whether the socket's folder is only the user's.
  - `guard.ts`: `isGoogleChromeExecutable`, true only for stable Google Chrome's executable path, and `isExtensionOrigin`.
  - `router.ts`: `route`, a pure transition from the router's state and an event (a client's connection, data, end or close, a message from the extension, a timeout, the port closing) to its next state and effects. Each connection's responses go out in the order of its requests.
  - `claim.ts`: `claimSocket` and `releaseSocket`, how one host of several started at once comes to serve the socket and lets go of it, through the steps of `SocketEdge`: each host makes a claim socket of its own beside the socket, serves only when no other claim answers, and closes the socket before its claim.
  - `host.ts`: `run`, the edge, which checks the parent and the origin, claims and binds the socket, and carries out the router's effects; `processIo` gives it the process's streams.
  - `main.ts`: the entry point, which finds the parent's executable with `/bin/ps`. There is no switch that skips its checks.
- `src/command/`: the `declarative-tab-groups` command.
  - `arguments.ts`: `parseArguments`, from the arguments to help, the version, a command value or a usage error.
  - `help.ts`: the `--help` texts.
  - `output.ts`: `requestFor`, `urlsFromText`, `output`, which renders a response, and `exitStatus`.
  - `run.ts`: `runCommand`, the edge, which reads `--urls-from`, sends one line and reads one, waiting at most `RESPONSE_DEADLINE_MS`; `main.ts` is the entry point.
  - `version.ts`: the version, read from `package.json`.
- `test/host/`, `test/command/`: their tests. `processes.ts` runs a host with real framing on its pipes, a client on its socket, and the command; `launch-host.ts` is the test-only launcher that calls the host's `run` with a parent lookup that answers Google Chrome's path, and `entry-point.test.ts` sees the real entry point refuse; `claim.test.ts` runs every interleaving of two hosts' claims on a model of the file system; `bundle.test.ts` runs the bundled programs.
- `docs/protocol.md`: the protocol's reference for a client author. Each `json` example's info string names the message it shows (`request`, `response`, `host-message` or `extension-message`), and the tests check it with that message's parser.
- `skills-devshell/`: the sub-flake that installs this repository's skills into `.agents/skills/`.
- `.agents/skills/*.preferences.md`: this repository's preferences for those skills.

## Style

The TypeScript is functional: pure functions over `readonly` values, with no classes, no enums, no `any`, and no change to anything a function is given; I/O stays in the edges named above. The one exception is a local accumulator: a function may fill an array it made, or move a cursor it declared, in a loop, where recursion would cost stack depth or spreading would copy over and over, as the frame and line splitters do with a chunk of many messages.

## The minimum Chrome version

`manifest.json` asks for Chrome 126 or later. The protocol module's URL check calls `URL.parse`, which Chrome has from version 126; that also covers the status page's CSS `light-dark()` (Chrome 123), the reconnect alarm's 30-second period (Chrome 120) and module service workers (Chrome 92). esbuild targets the same version.

## Build and test

Enter the dev shell with `nix develop`; it puts Node on the `PATH`, and `menu` lists its commands. Run `npm ci` once to install the development dependencies.

- `npm test`: runs the tests.
- `npm run typecheck`: type-checks each of the TypeScript projects with `tsc -p`.
- `npm run build`: writes the unpacked extension to `dist/extension/`: `manifest.json`, the bundled service worker `service-worker.js`, the empty page `empty.html`, the status page `status.html` with its stylesheet `status.css`, and the options page `options.html`, each page with its bundled script of the same name; and the bundled command and host to `dist/programs/`.
- `nix build`: builds the package, which installs the sources under `lib/node_modules/declarative-tab-groups/`, the unpacked extension under `share/declarative-tab-groups/extension/`, the command as `bin/declarative-tab-groups` and the host as `libexec/declarative-tab-groups-host`, both on the flake's Node.
- `nix fmt`: formats the tree with treefmt: Nix with nixfmt, and Markdown, TypeScript, HTML and JSON with Prettier, `package-lock.json` excepted.
- `nix flake check`: builds the package, and with it the extension and the programs, runs the installed programs, runs the type check and the tests on the dependencies `package-lock.json` pins, and fails on any file `nix fmt` would change.
