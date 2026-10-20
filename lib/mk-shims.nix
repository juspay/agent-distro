# Keep installed commands usable while independently refreshing the package
# they came from: one shim per `<package>.commands`, each execing
# `<stateDirectory>/current/bin/<name>` when an update has landed, else the
# package's own command. `profile` is exported as AI_PROFILE unless the
# environment already sets one, so it is the fallback a repository's own
# profile still overrides.
{ pkgs, package, stateDirectory, profile ? null }:
let
  inherit (pkgs) lib;
  # Fail fast on the wrong kind of package: only the one lib/mk-launchers.nix
  # builds carries `commands`.
  names = if package ? commands then package.commands
    else throw "mkShims: `package` has no `commands`; pass the package built by mkLaunchers of this agent-distro.";
in
pkgs.symlinkJoin {
  name = "agent-distro-shims";
  paths = map
    (name: pkgs.writeShellScriptBin name (lib.optionalString (profile != null) ''
      if [ -z "''${AI_PROFILE:-}" ]; then
        export AI_PROFILE=${lib.escapeShellArg profile}
      fi
    '' + ''
      state=${lib.escapeShellArg stateDirectory}
      if [ -x "$state/current/bin/${name}" ]; then
        exec "$state/current/bin/${name}" "$@"
      fi
      exec ${package}/bin/${name} "$@"
    ''))
    names;
  passthru = { inherit names stateDirectory profile; };
}
