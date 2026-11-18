# declarative-tab-groups

A Google Chrome extension, a native-messaging host and a command, `declarative-tab-groups`, that let any local program set a named tab group's exact tabs without taking focus, on macOS.

## Layout

- `flake.nix`: the dev shell, the formatter and the checks.
- `skills-devshell/`: the sub-flake that installs this repository's skills into `.agents/skills/`.
- `.agents/skills/*.preferences.md`: this repository's preferences for those skills.

## Build and test

Enter the dev shell with `nix develop`; it puts Node on the `PATH`, and `menu` lists its commands.

- `nix fmt`: formats the tree with treefmt.
- `nix flake check`: fails on any file `nix fmt` would change.
