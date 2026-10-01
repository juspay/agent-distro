{ pkgs }:
let
  sources = import ./npins;
  packagePkgs = import ../../lib/upstream-pkgs.nix { inherit pkgs; src = sources.claude-code-nix; };
in
packagePkgs.callPackage "${sources.claude-code-nix}/package.nix" { }
