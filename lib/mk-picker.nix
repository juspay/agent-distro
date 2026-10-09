# The documented export of lib/picker.nix: a callPackage adapter so any
# consumer can build the picker over one profile's launchers from a plain
# import, not only through flake.nix.
{ pkgs, profile, launchers }:
pkgs.callPackage ./picker.nix { inherit profile launchers; }
