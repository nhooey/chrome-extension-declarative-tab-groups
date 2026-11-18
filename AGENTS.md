# declarative-tab-groups

A Google Chrome extension, a native-messaging host and a command, `declarative-tab-groups`, that let any local program set a named tab group's exact tabs without taking focus, on macOS.

## Layout

- `flake.nix`: the package, the dev shell, the formatter and the checks.
- `nix/run-npm-script.sh`: the build command of the checks that run an npm script.
- `package.json`, `package-lock.json`, `tsconfig.json`: the Node package, written in TypeScript that Node runs by stripping its types; its only dependencies are TypeScript and Node's types, for development.
- `src/protocol/`: the protocol module the extension, the host and the command share. It is pure functional TypeScript, with no I/O and no Node or Chrome API, and `index.ts` exports all of it.
- `test/protocol/`: its tests, under `node --test` with `node:test` and `node:assert/strict`; `docs.test.ts` parses every `json` example of `docs/protocol.md`.
- `src/extension/`: the extension's pure core, with no `chrome.*` call:
  - `state.ts`: what the planner knows of Chrome: the groups, each tab's kind (the status page, the empty page or another page) and form state, the window a new group goes in, and whether the status page is on.
  - `steps.ts`: the steps a plan is made of, as plain data, and `STEP_KINDS`, every kind of step; none focuses a window or activates a tab. A tab the plan opens is named by its role and position, since it has no id yet.
  - `plan.ts`: `plan`, which turns the state and a `set` request into the ordered steps and what the response reports, or a failure.
  - `form-check.ts`: `hasUnsubmittedForm`, which Chrome serialises and runs in every frame of a tab, so it imports and closes over nothing, and `tabFormState`, which folds a tab's frame results into `clean`, `unsubmitted` or `unchecked`.
- `test/extension/`: their tests. `simulate.ts` applies a plan's steps to a model of the group and `generate.ts` makes seeded states and requests, for the properties `plan-properties.test.ts` checks; `form-check.test.ts` runs the form check from its source in a `node:vm` context whose global is a fake window.
- `docs/protocol.md`: the protocol's reference for a client author. Each `json` example's info string names the message it shows (`request`, `response`, `host-message` or `extension-message`), and the tests check it with that message's parser.
- `skills-devshell/`: the sub-flake that installs this repository's skills into `.agents/skills/`.
- `.agents/skills/*.preferences.md`: this repository's preferences for those skills.

## Build and test

Enter the dev shell with `nix develop`; it puts Node on the `PATH`, and `menu` lists its commands. Run `npm ci` once to install TypeScript for the type check.

- `npm test`: runs the tests.
- `npm run typecheck`: type-checks the sources and the tests with `tsc --noEmit`.
- `nix build`: builds the package, which installs the sources under `lib/node_modules/declarative-tab-groups/`.
- `nix fmt`: formats the tree with treefmt: Nix with nixfmt, and Markdown, TypeScript and JSON with Prettier, `package-lock.json` excepted.
- `nix flake check`: builds the package, runs the type check and the tests on the dependencies `package-lock.json` pins, and fails on any file `nix fmt` would change.
