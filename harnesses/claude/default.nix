# Claude's plugin layout and CLI are local to this adapter. Shared sources stay
# portable; no provider initialization or persistent plugin install is needed.
{ pkgs, plugins, gateway, package, profileName }:
let
  inherit (pkgs) lib callPackage writeShellApplication runCommand writeText runtimeShell coreutils;
  claude = package;

  runtime = import ../../lib/runtime.nix pkgs;
  readPlugin = callPackage ../../lib/read-plugin.nix { };
  adaptPlugin = plugin: runCommand "claude-plugin" { } ''
    ${runtime.script "harness/claude.ts"} "$out" ${writeText "claude-plugin-args.json" (builtins.toJSON {
      bash = runtimeShell;
      env = "${coreutils}/bin/env";
      description = "${readPlugin plugin}";
    })}
  '';
  pluginFlags = lib.concatMapStringsSep " "
    (plugin: "--plugin-dir ${lib.escapeShellArg (toString (adaptPlugin plugin))}")
    plugins;
in
writeShellApplication {
  name = "claude";
  derivationArgs.version = claude.version;
  text = ''
    exec ${lib.getExe claude} ${pluginFlags} "$@"
  '';
}
