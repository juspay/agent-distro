# Keep installed commands usable while independently refreshing their selected
# distribution: one shim per `bundle.commands`, each execing
# `<stateDirectory>/current/bin/<name>` when an update has landed, else the
# bundle's own command.
{ pkgs, bundle, stateDirectory }:
let
  inherit (pkgs) lib;
  # Fail fast on the wrong kind of bundle: only a mkLaunchers bundle carries
  # `commands` (plain derivations, and bundles from other distros, do not).
  names = if bundle ? commands then bundle.commands
    else throw "mkShims: `bundle` has no `commands`; pass a bundle built with mkLaunchers of this agent-distro.";
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
