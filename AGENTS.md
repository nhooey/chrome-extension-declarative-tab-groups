# declarative-tab-groups

A Google Chrome extension, a native-messaging host and a command, `declarative-tab-groups`, that let any local program set a named tab group's exact tabs without taking focus, on macOS.

## Layout

- `flake.nix`: the package, the dev shell, the formatter and the checks.
- `nix/run-npm-script.sh`: the build command of the checks that run an npm script.
- `package.json`, `package-lock.json`: the Node package, written in TypeScript that Node runs by stripping its types. Its dependencies are all for development: TypeScript, Node's and Chrome's types, and esbuild, which bundles the extension.
- `tsconfig.base.json` and three projects that extend it, so each part is type-checked against only the APIs it may use:
  - `tsconfig.json`: the tests and `scripts/`, with Node's types.
  - `src/protocol/tsconfig.json`: the protocol module, with the Web APIs and neither Node's nor Chrome's.
  - `src/extension/tsconfig.json`: the extension, with the Web APIs and Chrome's types, and not Node's.
- `scripts/build.ts`: `buildExtension`, which writes the unpacked extension into one folder.
- `src/protocol/`: the protocol module the extension, the host and the command share. It is pure functional TypeScript, with no I/O and no Node or Chrome API, and `index.ts` exports all of it.
- `test/protocol/`: its tests, under `node --test` with `node:test` and `node:assert/strict`; `docs.test.ts` parses every `json` example of `docs/protocol.md`.
- `src/extension/`: the extension. Only `background.ts` names the `chrome` global; every other module takes Chrome as a parameter, so the tests run it against fakes.
  - `manifest.json`: the Manifest V3 manifest, not allowed in incognito windows. Its `key`, the public half of an RSA key whose private half exists nowhere, fixes the extension's ID; an unpacked extension needs no private key.
  - `identity.ts`: `NATIVE_HOST_NAME`, the native host's name, `EXTENSION_ID`, and `extensionIdFromKey`, which derives the ID from a key as Chrome does.
  - `browser.ts`: `isGoogleChrome`, true only for a brand list naming "Google Chrome", and `chromeVersion`.
  - `tab-strip.ts`: `TabStrip`, the narrowed interface through which the extension reaches Chrome's tabs, windows, groups and scripts, and whether it may open file URLs. It names exactly the Chrome operations used, none of which can focus: there is no `windows.update`, `tabs.update` or `tabs.highlight`, `tabs.create` takes only `active: false` and `windows.create` only `focused: false`. `narrowTabStrip` keeps only those operations of Chrome, and passes Chrome only the fields the interface names; its `scripting.executeScript` takes no function and always injects the form check, `hasUnsubmittedForm`. Beside it, `Clock`, through which all waiting goes, `within`, which bounds a wait by the clock, and `Edge`, the two with the extension's page URLs and the signal that aborts when a request is given up.
  - `state.ts`: what the planner knows of Chrome: the groups, each tab's kind (the status page, the empty page or another page) and form state, the window a new group goes in, and whether the status page is on.
  - `read-state.ts`: `readGroupState`, which reads that state with the status page off, `tabKind`, which tells the extension's own pages by their URL, and `groupsTitled`, the groups of normal windows with an exact title. A discarded, frozen or unloaded tab is `unchecked` without the form check, and a form check that has not answered in 5 seconds is `unchecked` too.
  - `steps.ts`: the steps a plan is made of, as plain data, and `STEP_KINDS`, every kind of step; none focuses a window or activates a tab. A tab the plan opens is named by its role and position, since it has no id yet.
  - `plan.ts`: `plan`, which turns the state and a `set` request into the ordered steps and what the response reports, or a failure.
  - `run-plan.ts`: `runPlan`, which carries out the steps in order and answers the `set` request. A new tab opens at the window's end and is then put in its place by the group's tabs as read just before, so a tab added meanwhile cannot disorder the pages. A tab to close that has gone meanwhile is skipped. A change Chrome refuses while the user drags a tab is tried again for 5 seconds, then answered with `busy`; the opened pages are waited for up to 30 seconds.
  - `form-check.ts`: `hasUnsubmittedForm`, which Chrome serialises and runs in every frame of a tab, so it imports and closes over nothing, and `tabFormState`, which folds a tab's frame results into `clean`, `unsubmitted` or `unchecked`.
  - `commands.ts`: `handleRequest`, the answer to `set`, `get` and `status`, which never throws and answers `internal` after 90 seconds, then aborts the request's signal so its run, checking it before each step, retry, poll and read, calls Chrome no more once the call under way returns, and `queueKey`, the queue each request waits in. A `set` with a file URL fails with `invalid-request`, before any change, while the user has not allowed the extension file URLs.
  - `queue.ts`: `queueByKey`, which runs the requests on one group one at a time, in arrival order, with at most 100 waiting; the worker answers one more with `busy`.
  - `connection.ts`: the native port's `transition`, a pure function from the connection's state and an event to its next state and the effects to carry out. A port whose host sends no hello in 10 seconds is dropped, and the alarm retries.
  - `service-worker.ts`: `startServiceWorker`, the edge that carries out those effects and holds the port, the connection's state and the queue. Outside Google Chrome it does nothing at all.
  - `background.ts`: the service worker's entry point, which hands Chrome to `startServiceWorker`.
  - `empty.html` and `empty.ts`: the page an empty group holds, naming the group from its `?group=` query.
- `test/extension/`: their tests. `simulate.ts` applies a plan's steps to a model of the group and `generate.ts` makes seeded states and requests, for the properties `plan-properties.test.ts` checks; `form-check.test.ts` runs the form check from its source in a `node:vm` context whose global is a fake window; `fake-chrome.ts` is an in-memory Chrome behind `TabStrip` that records every call, which the `set`, `get` and never-focus tests run against.
- `docs/protocol.md`: the protocol's reference for a client author. Each `json` example's info string names the message it shows (`request`, `response`, `host-message` or `extension-message`), and the tests check it with that message's parser.
- `skills-devshell/`: the sub-flake that installs this repository's skills into `.agents/skills/`.
- `.agents/skills/*.preferences.md`: this repository's preferences for those skills.

## The minimum Chrome version

`manifest.json` asks for Chrome 126 or later. The protocol module's URL check calls `URL.parse`, which Chrome has from version 126; that also covers the reconnect alarm's 30-second period (Chrome 120) and module service workers (Chrome 92). esbuild targets the same version.

## Build and test

Enter the dev shell with `nix develop`; it puts Node on the `PATH`, and `menu` lists its commands. Run `npm ci` once to install the development dependencies.

- `npm test`: runs the tests.
- `npm run typecheck`: type-checks each of the three TypeScript projects with `tsc -p`.
- `npm run build`: writes the unpacked extension to `dist/extension/`: `manifest.json`, the bundled service worker `service-worker.js`, and the empty page `empty.html` with its script `empty.js`.
- `nix build`: builds the package, which installs the sources under `lib/node_modules/declarative-tab-groups/` and the unpacked extension under `share/declarative-tab-groups/extension/`.
- `nix fmt`: formats the tree with treefmt: Nix with nixfmt, and Markdown, TypeScript, HTML and JSON with Prettier, `package-lock.json` excepted.
- `nix flake check`: builds the package, and with it the extension, runs the type check and the tests on the dependencies `package-lock.json` pins, and fails on any file `nix fmt` would change.
