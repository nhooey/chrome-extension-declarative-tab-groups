{
  description = "declarative-tab-groups: a Chrome extension, native host and command that set a named tab group's exact tabs from any local program, without taking focus";

  inputs = {
    # Rolling, for a current Node: the tests run TypeScript straight through
    # `node --test`, which strips the types.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts = {
      url = "github:hercules-ci/flake-parts";
      inputs.nixpkgs-lib.follows = "nixpkgs";
    };
    systems.url = "github:nix-systems/default";
    # The builder library, not a skill: it exports the
    # `flakeModules.devshellSkills` module for the dev shell. The dev shell's
    # skills live in the `skills-devshell/` sub-flake, invoked at runtime, so
    # this flake carries no skill inputs.
    agent-skill-flake = {
      url = "github:nhooey/agent-skill-flake";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { flake-parts, ... }@inputs:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = import inputs.systems;
      imports = [
        # Bundles numtide/devshell, the skills startup that installs
        # skills-devshell/'s skills into .agents/skills, and the check, fmt
        # and update-flake commands.
        inputs.agent-skill-flake.flakeModules.devshellSkills
        inputs.treefmt-nix.flakeModule
      ];

      agent-skill-flake.devshellSkills = {
        name = "chrome-extension-declarative-tab-groups";
      };

      perSystem =
        { pkgs, ... }:
        let
          inherit (pkgs) lib;

          # The one Node: the package and its npm dependencies are built with
          # it, and the dev shell and the checks run it.
          nodejs = pkgs.nodejs_26;

          packageJson = lib.importJSON ./package.json;

          # The npm dependencies, each fetched by the integrity hash
          # package-lock.json records, so no hash is kept beside the lock.
          npmLock = {
            package = packageJson;
            packageLock = lib.importJSON ./package-lock.json;
          };

          # The development dependencies as one node_modules, for the checks.
          nodeModules = pkgs.importNpmLock.buildNodeModules (npmLock // { inherit nodejs; });

          # The package: its sources under lib/node_modules/, and the
          # unpacked extension `npm run build` bundles under
          # share/declarative-tab-groups/extension/; it has no executable.
          package = pkgs.buildNpmPackage {
            pname = packageJson.name;
            inherit (packageJson) version;
            inherit nodejs;
            src = lib.fileset.toSource {
              root = ./.;
              fileset = lib.fileset.unions [
                ./package.json
                ./package-lock.json
                ./tsconfig.base.json
                ./scripts
                ./src
              ];
            };
            npmDeps = pkgs.importNpmLock npmLock;
            inherit (pkgs.importNpmLock) npmConfigHook;
            postInstall = ''
              mkdir -p "$out/share/declarative-tab-groups"
              cp -R dist/extension "$out/share/declarative-tab-groups/extension"
            '';
          };

          # Runs one of package.json's scripts on the sources, the tests and
          # the document the tests read, with the flake's node_modules.
          npmCheck =
            name: script:
            pkgs.runCommand "declarative-tab-groups-${name}" {
              nativeBuildInputs = [ nodejs ];
              src = lib.fileset.toSource {
                root = ./.;
                fileset = lib.fileset.unions [
                  ./package.json
                  ./tsconfig.json
                  ./tsconfig.base.json
                  ./scripts
                  ./src
                  ./test
                  ./docs/protocol.md
                ];
              };
              nodeModules = "${nodeModules}/node_modules";
              inherit script;
            } (builtins.readFile ./nix/run-npm-script.sh);
        in
        {
          packages.default = package;

          checks = {
            inherit package;
            typecheck = npmCheck "typecheck" "typecheck";
            tests = npmCheck "tests" "test";
          };

          # Repo-specific packages, merged onto the module's dev shell.
          devshells.default = {
            packages = [ nodejs ];
          };

          # `nix fmt` formats the tree, and `nix flake check` fails on an
          # unformatted file through treefmt-nix's `checks.treefmt`.
          treefmt = {
            projectRootFile = "flake.nix";
            programs.nixfmt.enable = true;
            # Markdown, YAML, TypeScript and JSON.
            programs.prettier.enable = true;
            settings.global.excludes = [
              ".agents/**" # installed third-party skills, not ours to reformat
              ".claude/**"
              "package-lock.json" # npm's output, kept as npm writes it
            ];
          };
        };
    };
}
