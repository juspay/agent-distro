# Google documents no flag that loads a plugin for one launch, only the folder
# `agy` reads plugins from: src/harness/agy.ts places each plugin in
# `~/.gemini/config/plugins/` for this launch's session, and takes it back once
# no running launch uses it.
{ pkgs, name, package, launchPlugins }:
let
  inherit (pkgs) lib writeShellApplication;
  agy = package;
  runtime = import ../../lib/runtime.nix pkgs;
in
writeShellApplication {
  inherit name;
  derivationArgs.version = agy.version;
  text = ''
    # The profiles in effect, their env and packages, and the plugins of those
    # and of AGENT_DISTRO_PLUGINS, by name; nothing is added to agy's command
    # line. Like Claude Code and Codex, agy has a login of its own, so no
    # `secret` of the profile is prompted for.
    ${launchPlugins { }}
    # This shell's pid is the session's: `exec` hands it to agy. A run that
    # only lists models (`agent-distro --models agy`) leaves ~/.gemini/config
    # as it is.
    if [ "''${1:-}" != models ]; then
      ${runtime.script "harness/agy.ts"} link ${pkgs.flock}/bin/flock "$$" "$launched"
    fi
    exec ${lib.getExe agy} "$@"
  '';
}
