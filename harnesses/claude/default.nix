# Claude's plugin layout and CLI are local to this adapter. Shared sources stay
# portable; no provider initialization or persistent plugin install is needed.
{ pkgs, nixpkgs, package }:
let
  inherit (pkgs) lib writeShellApplication;
  claude = package;

  runtime = import ../../lib/runtime.nix pkgs;
  launchPlugins = runtime.launchPlugins (runtime.info nixpkgs // { harness = "claude"; });
in
writeShellApplication {
  name = "claude";
  derivationArgs.version = claude.version;
  text = ''
    # The profiles in effect, their env and packages, and every plugin's
    # launch-time translation.
    ${launchPlugins}
    eval "set -- $launched \"\$@\""
    exec ${lib.getExe claude} "$@"
  '';
}
