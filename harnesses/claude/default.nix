# Claude's plugin layout and CLI are local to this adapter. Shared sources stay
# portable; no provider initialization or persistent plugin install is needed.
{ pkgs, name, package, launchPlugins }:
let
  inherit (pkgs) lib writeShellApplication;
  claude = package;
  runtime = import ../../lib/runtime.nix pkgs;
in
writeShellApplication {
  inherit name;
  derivationArgs.version = claude.version;
  text = ''
    # The profiles in effect, their env and packages, and every plugin's
    # launch-time translation.
    ${launchPlugins { }}
    # Claude Code ends the commits and pull request descriptions it writes with
    # attribution of its own. This session's is empty, so it writes none —
    # unless a settings file of the user's decides attribution, when this is
    # empty instead (src/harness/claude.ts). It leads the launch, so a
    # `--settings` of the user's own comes after it and wins.
    attribution=$(${runtime.script "harness/claude.ts"} attribution)
    eval "set -- $attribution $launched \"\$@\""
    exec ${lib.getExe claude} "$@"
  '';
}
