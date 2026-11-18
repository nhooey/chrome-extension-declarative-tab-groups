# The flake's `home-manager-module` check: evaluates the Home Manager module
# without Home Manager, against stand-ins for the options it sets, and
# builds an empty output only when, enabled, it yields exactly the package
# and the two links, and, disabled, nothing.
{
  lib,
  pkgs,
  module,
  package,
}:
let
  identity = lib.importJSON ../src/extension/identity.json;
  manifestFile = "${identity.nativeHostName}.json";

  # Home Manager's options, as far as the module sets them.
  stubs = {
    options = {
      assertions = lib.mkOption {
        type = lib.types.listOf lib.types.unspecified;
        default = [ ];
      };
      home.packages = lib.mkOption {
        type = lib.types.listOf lib.types.package;
        default = [ ];
      };
      home.file = lib.mkOption {
        type = lib.types.attrsOf (
          lib.types.submodule {
            options.source = lib.mkOption { type = lib.types.path; };
          }
        );
        default = { };
      };
      xdg.dataHome = lib.mkOption {
        type = lib.types.str;
        default = "/home/u/.local/share";
      };
    };
  };

  evaluate =
    settings:
    (lib.evalModules {
      modules = [
        stubs
        module
        settings
        { _module.args.pkgs = pkgs; }
      ];
    }).config;

  enabled = evaluate { programs.declarative-tab-groups.enable = true; };
  disabled = evaluate { };

  sources = config: lib.mapAttrs (_: file: toString file.source) config.home.file;
  outPaths = map (p: p.outPath);

  failures =
    lib.optional (
      sources enabled != {
        "Library/Application Support/Google/Chrome/NativeMessagingHosts/${manifestFile}" =
          "${package}/share/declarative-tab-groups/native-messaging-host/${manifestFile}";
        "/home/u/.local/share/declarative-tab-groups/extension" =
          "${package}/share/declarative-tab-groups/extension";
      }
    ) "enabled, the module links ${builtins.toJSON (sources enabled)}"
    ++ lib.optional (
      outPaths enabled.home.packages != [ package.outPath ]
    ) "enabled, the module installs ${toString (outPaths enabled.home.packages)}"
    ++ lib.optional (
      map (a: a.assertion) enabled.assertions != [ pkgs.stdenv.hostPlatform.isDarwin ]
    ) "enabled, the module asserts macOS ${builtins.toJSON enabled.assertions}"
    ++ lib.optional (
      disabled.home.file != { } || disabled.home.packages != [ ] || disabled.assertions != [ ]
    ) "disabled, the module sets something";
in
if failures == [ ] then
  pkgs.runCommand "declarative-tab-groups-home-manager-module" { } "touch $out"
else
  throw "the Home Manager module: ${lib.concatStringsSep "; " failures}"
