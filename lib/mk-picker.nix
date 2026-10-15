# The documented export of lib/picker.nix: a callPackage adapter so any
# consumer can build the picker over a set of launchers from a plain import,
# not only through flake.nix. `nixpkgs` is as lib/mk-launchers.nix's.
{ pkgs, launchers, nixpkgs ? null }:
pkgs.callPackage ./picker.nix { inherit launchers nixpkgs; }
