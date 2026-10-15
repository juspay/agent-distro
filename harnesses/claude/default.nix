# Claude's plugin layout and CLI are local to this adapter. Shared sources stay
# portable; no provider initialization or persistent plugin install is needed.
{ pkgs, name, package, launchPlugins }:
let
  inherit (pkgs) lib writeShellApplication;
  claude = package;
in
writeShellApplication {
  inherit name;
  derivationArgs.version = claude.version;
  text = ''
    # The profiles in effect, their env and packages, and every plugin's
    # launch-time translation.
    ${launchPlugins { }}
    eval "set -- $launched \"\$@\""
    exec ${lib.getExe claude} "$@"
  '';
}
