# declarative-tab-groups

A Google Chrome extension, a native-messaging host and a command, `declarative-tab-groups`, that let any local program set a named tab group's exact tabs without taking focus, on macOS.

## Layout

- `flake.nix`: the package, the dev shell, the formatter and the checks.
- `nix/run-npm-script.sh`: the build command of the checks that run an npm script.
- `package.json`, `package-lock.json`, `tsconfig.json`: the Node package, written in TypeScript that Node runs by stripping its types; its only dependencies are TypeScript and Node's types, for development.
- `src/protocol/`: the protocol module the extension, the host and the command share. It is pure functional TypeScript, with no I/O and no Node or Chrome API, and `index.ts` exports all of it.
- `test/protocol/`: its tests, under `node --test` with `node:test` and `node:assert/strict`; `docs.test.ts` parses every `json` example of `docs/protocol.md`.
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
