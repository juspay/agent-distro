{ pkgs }:
let
  sources = import ./npins;
  packagePkgs = import ../../lib/upstream-pkgs.nix { inherit pkgs; src = sources.codex-cli-nix; };
in
packagePkgs.callPackage "${sources.codex-cli-nix}/package.nix" { runtime = "native"; }
