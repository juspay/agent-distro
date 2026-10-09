# Claude's plugin layout and CLI are local to this adapter. Shared sources stay
# portable; no provider initialization or persistent plugin install is needed.
{ pkgs, plugins, info, package }:
let
  inherit (pkgs) lib writeShellApplication runCommand writeText runtimeShell coreutils;
  claude = package;

  runtime = import ../../lib/runtime.nix pkgs;
  adaptPlugin = plugin: runCommand "claude-plugin" { } ''
    ${runtime.script "harness/claude.ts"} "$out" ${writeText "claude-plugin-args.json" (builtins.toJSON {
      bash = runtimeShell;
      env = "${coreutils}/bin/env";
      description = "${runtime.readPlugin plugin}";
    })}
  '';
  launchPlugins = runtime.launchPlugins {
    harness = "claude";
    inherit info;
    bash = runtimeShell;
    env = "${coreutils}/bin/env";
    profile = map (plugin: { description = "${runtime.readPlugin plugin}"; dir = "${adaptPlugin plugin}"; }) plugins;
  };
in
writeShellApplication {
  name = "claude";
  derivationArgs.version = claude.version;
  text = ''
    # The profile in effect and its packages, and its plugin dirs, less those
    # AGENT_DISTRO_PLUGINS replaces, then the variable's own.
    ${launchPlugins}
    eval "set -- $launched \"\$@\""
    exec ${lib.getExe claude} "$@"
  '';
}
