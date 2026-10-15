# The single source of the library every Nix consumer reaches as
# agent-distro.lib: the shared functions a consumer uses to keep a profile
# installed, updated, built and chosen. `cache` and `caIndex` carry each site's
# own values; everything else is built from this nixpkgs, so a consumer and the
# distribution's own flake expose exactly the same nine names.
{ nixpkgs, cache, caIndex ? import ./ca-index.nix }:
let
  inherit (nixpkgs) lib;
in
{
  inherit cache caIndex;
  stateDirectory = import ./state-directory.nix;
  mkLaunchers = args: import ./mk-launchers.nix ({ inherit nixpkgs; } // args);
  mkProfile = args: import ./mk-profile.nix ({ inherit nixpkgs; } // args);
  mkPicker = import ./mk-picker.nix;
  mkShims = import ./mk-shims.nix;
  mkUpdater = import ./mk-updater.nix;
  schedule = import ./schedule.nix lib;
}
