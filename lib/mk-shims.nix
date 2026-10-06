# Keep installed commands usable while independently refreshing their selected
# distribution: one shim per `bundle.commands`, each execing
# `<stateDirectory>/current/bin/<name>` when an update has landed, else the
# bundle's own command.
{ pkgs, bundle, stateDirectory }:
let
  inherit (pkgs) lib;
  # Discover commands from the bundle, keeping shims and collision checks together.
  names = bundle.commands;
in
pkgs.symlinkJoin {
  name = "agent-distro-shims";
  paths = map
    (name: pkgs.writeShellScriptBin name ''
      state=${lib.escapeShellArg stateDirectory}
      if [ -x "$state/current/bin/${name}" ]; then
        exec "$state/current/bin/${name}" "$@"
      fi
      exec ${bundle}/bin/${name} "$@"
    '')
    names;
  passthru = { inherit names stateDirectory; };
}