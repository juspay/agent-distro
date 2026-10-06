# Build the updater a consumer runs to refresh one distribution from its flake,
# never compiling. `command` is the bare Node invocation of src/update/update.ts
# with the generated `config`; `program` is the same invocation wrapped for a
# process that only wants one executable. The schedule (update period and
# phase) comes from lib/schedule.nix, the same numbers the module and every
# other consumer read.
{ pkgs, bundle, flake, profile, stateDirectory, history, nix, substituters }:
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
    inherit profile flake substituters nix;
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
