# Build the updater a consumer runs to refresh one distribution from its flake,
# never compiling. `command` is the bare Node invocation of src/update/update.ts
# with the generated `config`; `program` is the same invocation wrapped for a
# process that only wants one executable. The schedule (update period and
# phase) comes from lib/schedule.nix, the same numbers the module and every
# other consumer read.
#
# A consumer that wants to show the download live appends `--progress` to
# `command` (`command ++ [ "--progress" ]`): the same update, with stdout
# machine-readable — one JSON object per line, `{"progress":{"done":…,"total":…}}`
# while nix fetches and then one `{"result":…}` — and every human message on
# stderr. Nothing else changes; the history log and the exit codes are the same.
#
# `caIndex` is where the updater reads which content-addressed bundle CI
# published for the revision it is on (lib/ca-index.nix); a distribution that
# publishes its own passes its own base, or its revs are looked up in this
# one's index and found absent.
{ pkgs, bundle, flake, profile, stateDirectory, history, nix, substituters
, caIndex ? (import ./ca-index.nix).rawBase }:
let
  inherit (pkgs) lib;
  # Fail fast on the wrong kind of bundle: `runtime` arrived with the TypeScript
  # runtime (post-#59); anything older, or a non-mkLaunchers bundle, is missing it.
  runtime = if bundle ? runtime then bundle.runtime
    else throw "mkUpdater: `bundle` has no `runtime`; build it with mkLaunchers of this agent-distro (bundles built before the TypeScript runtime, pre-#59, have no `runtime`).";
  schedule = import ./schedule.nix lib;
  # src/update/update.ts is the updater, cache check and history log; the
  # bundle supplies the Node and runtime tree its own launchers already use.
  config = pkgs.writeText "agent-distro-update.json" (builtins.toJSON {
    inherit profile flake substituters nix caIndex;
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
