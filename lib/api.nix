# The single source of the library every Nix consumer reaches as
# agent-distro.lib: built the same from flake.nix and from a third-party
# distribution's mkFlake, so both expose exactly the same ten names.
# `mkFlake`, `cache` and `caIndex` carry each site's own values; everything
# else is built from the nixpkgs it was given, or is one of the shared
# functions a consumer uses to keep a profile installed, updated, built and
# chosen on top of a mkFlake-built bundle.
{ nixpkgs, mkFlake, cache, caIndex ? import ./ca-index.nix }:
let
  inherit (nixpkgs) lib;
in
{
  inherit mkFlake cache caIndex;
  stateDirectory = import ./state-directory.nix;
  mkLaunchers = args: import ./mk-launchers.nix ({ inherit nixpkgs; } // args);
  mkProfile = args: import ./mk-profile.nix ({ inherit nixpkgs; } // args);
  mkShims = import ./mk-shims.nix;
  mkUpdater = import ./mk-updater.nix;
  mkPicker = import ./mk-picker.nix;
  schedule = import ./schedule.nix lib;
}
