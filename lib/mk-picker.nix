# The documented export of lib/picker.nix (whose body U1 owns): a callPackage
# adapter so any consumer can build the picker from a plain import, not only
# through flake.nix.
{ pkgs, profiles, default }:
pkgs.callPackage ./picker.nix { inherit profiles default; }