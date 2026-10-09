# The documented export of lib/picker.nix: a callPackage adapter so any
# consumer can build the picker over one profile's launchers from a plain
# import, not only through flake.nix. `nixpkgs` is as lib/mk-launchers.nix's.
{ pkgs, profile, launchers, nixpkgs ? null }:
pkgs.callPackage ./picker.nix { inherit launchers; info = (import ./runtime.nix pkgs).info profile nixpkgs; }
