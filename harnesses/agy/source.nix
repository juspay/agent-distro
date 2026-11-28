# Unfree: called with the package set that allows it, as every harness recipe is.
{ pkgs }: (import ../../lib/harness-pkgs.nix pkgs).callPackage ./package.nix { }
