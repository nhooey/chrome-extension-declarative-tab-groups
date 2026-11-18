# The Home Manager module, the flake's `homeManagerModules.default`. It
# makes the links `declarative-tab-groups install` makes, through
# `home.file`: the native host's manifest in Google Chrome's
# native-messaging folder, and the unpacked extension at a path that stays
# the same from one package to the next. A function of the flake's
# `packages`, so `package` defaults to this flake's for the system.
packages:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.declarative-tab-groups;
  layout = lib.importJSON ../src/command/layout.json;
  identity = lib.importJSON ../src/extension/identity.json;
  manifestFile = "${identity.nativeHostName}.json";
in
{
  options.programs.declarative-tab-groups = {
    enable = lib.mkEnableOption "declarative-tab-groups, which sets a named Google Chrome tab group's exact tabs from any local program";

    package = lib.mkOption {
      type = lib.types.package;
      default = packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "declarative-tab-groups.packages.\${pkgs.stdenv.hostPlatform.system}.default";
      description = "The declarative-tab-groups package.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = pkgs.stdenv.hostPlatform.isDarwin;
        message = "programs.declarative-tab-groups works only on macOS, where Google Chrome reads native-messaging hosts from ~/${layout.home.hostManifests}.";
      }
    ];

    home.packages = [ cfg.package ];

    home.file = {
      "${layout.home.hostManifests}/${manifestFile}".source =
        "${cfg.package}/${layout.package.hostManifests}/${manifestFile}";
      "${config.xdg.dataHome}/${layout.home.extension}".source =
        "${cfg.package}/${layout.package.extension}";
    };
  };
}
