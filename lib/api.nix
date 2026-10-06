# The single source of the library every Nix consumer reaches as
# agent-distro.lib: built the same from flake.nix and from a third-party
# distribution's mkFlake, so both expose exactly the same eight names.
# `mkLaunchers`, `mkFlake` and `cache` carry each site's own values; the rest
# are the shared functions a consumer uses to keep a profile installed,
# updated and chosen on top of a mkFlake-built bundle.
{ nixpkgs, mkLaunchers, mkFlake, cache }:
let
  inherit (nixpkgs) lib;
in
{
  inherit mkLaunchers mkFlake cache;
  stateDirectory = import ./state-directory.nix;
  mkShims = import ./mk-shims.nix;
  mkUpdater = import ./mk-updater.nix;
  mkPicker = import ./mk-picker.nix;
  schedule = import ./schedule.nix lib;
}
