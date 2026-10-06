# Build the updater a consumer runs to refresh one distribution from its flake,
# never compiling. `command` is the bare Node invocation of src/update/update.ts
# with the generated `config`; `program` is the same invocation wrapped for a
# process that only wants one executable. `periodSeconds`/`offsetSeconds`
# default to the schedule in lib/schedule.nix.
{ pkgs, bundle, flake, profile, stateDirectory, history, nix, substituters
, periodSeconds ? null, offsetSeconds ? null }:
let
  inherit (pkgs) lib;
  schedule = import ./schedule.nix lib;
  # launchd gates the same schedule as a period/phase pair: one period per
  # daily run, phased onto the first hour.
  effPeriod = if periodSeconds == null then schedule.updatePeriodSeconds else periodSeconds;
  effOffset = if offsetSeconds == null then schedule.updateOffsetSeconds else offsetSeconds;
  # src/update/update.ts is the updater, cache check and history log; the
  # bundle supplies the Node and runtime tree its own launchers already use.
  runtime = bundle.runtime;
  config = pkgs.writeText "agent-distro-update.json" (builtins.toJSON {
    inherit profile flake substituters nix;
    state = stateDirectory;
    inherit history;
    periodSeconds = effPeriod;
    offsetSeconds = effOffset;
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