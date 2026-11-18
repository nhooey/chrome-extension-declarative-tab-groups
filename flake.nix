{
  description = "declarative-tab-groups: a Chrome extension, native host and command that set a named tab group's exact tabs from any local program, without taking focus";

  inputs = {
    # Rolling, for a current Node in the dev shell.
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
        {
          # Repo-specific packages, merged onto the module's dev shell.
          devshells.default = {
            packages = [ pkgs.nodejs ];
          };

          # `nix fmt` formats the tree, and `nix flake check` fails on an
          # unformatted file through treefmt-nix's `checks.treefmt`.
          treefmt = {
            projectRootFile = "flake.nix";
            programs.nixfmt.enable = true;
            programs.prettier.enable = true;
            settings.global.excludes = [
              ".agents/**" # installed third-party skills, not ours to reformat
              ".claude/**"
            ];
          };
        };
    };
}
