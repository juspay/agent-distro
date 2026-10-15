# Build the updater a consumer runs to refresh the one package from its flake,
# never compiling. `command` is the bare Node invocation of src/update/update.ts
# with the generated `config`; `program` is the same invocation wrapped for a
# process that only wants one executable. The schedule (update period and
# phase) comes from lib/schedule.nix, the same numbers the module and every
# other consumer read.
#
# A consumer that wants to show the download live appends `--progress` to
# `command` (`command ++ [ "--progress" ]`): the same update, with stdout
# machine-readable — one JSON object per line while nix fetches and then one
# result — and every human message on stderr. Nothing else changes; the history
# log and the exit codes are the same.
#
# `attribute` is the flake attribute the update builds and the index names:
# `packages.<system>.default`, the one package. `caIndex` is where the updater
# reads which content-addressed closure CI published for the revision it is on
# (lib/ca-index.nix); a distribution that publishes its own passes its own base,
# or its revs are looked up in this one's index and found absent.
{ pkgs, package, flake, stateDirectory, history, nix, substituters
, attribute ? "default", caIndex ? (import ./ca-index.nix).rawBase }:
let
  inherit (pkgs) lib;
  # Fail fast on the wrong kind of package: `runtime` arrived with the TypeScript
  # runtime (post-#59); anything older, or one mkLaunchers did not build, is
  # missing it.
  runtime = if package ? runtime then package.runtime
    else throw "mkUpdater: `package` has no `runtime`; build it with mkLaunchers of this agent-distro (packages built before the TypeScript runtime, pre-#59, have no `runtime`).";
  schedule = import ./schedule.nix lib;
  # src/update/update.ts is the updater, cache check and history log; the
  # package supplies the Node and runtime tree its own launchers already use.
  config = pkgs.writeText "agent-distro-update.json" (builtins.toJSON {
    inherit attribute flake substituters nix caIndex;
    state = stateDirectory;
    inherit history;
    periodSeconds = schedule.updatePeriodSeconds;
    offsetSeconds = schedule.updateOffsetSeconds;
  });
  command = [ runtime.node "${runtime.tree}/src/update/update.ts" "${config}" ];
  program = pkgs.writeShellApplication {
    name = "agent-distro-update";
    text = ''
      exec ${lib.escapeShellArgs command} "$@"
    '';
  };
in
{
  inherit config command program;
}
