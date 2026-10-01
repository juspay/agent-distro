{ pkgs }:
let
  sources = import ./npins;
  packagePkgs = import ../../lib/upstream-pkgs.nix { inherit pkgs; src = sources.pi-nix; };
in
packagePkgs.callPackage "${sources.pi-nix}/package.nix" { }
