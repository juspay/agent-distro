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
    # The settings this session asks for and the user has not decided for
    # themselves — today, attribution of Claude Code's own on the commits and
    # pull requests it writes, which this leaves empty (src/harness/claude.ts
    # `SESSION_DEFAULTS`). It leads the launch, so a `--settings` of the
    # user's own comes after it and replaces it.
    settings=$(${runtime.script "harness/claude.ts"} settings)
    eval "set -- $settings $launched \"\$@\""
    exec ${lib.getExe claude} "$@"
  '';
}
