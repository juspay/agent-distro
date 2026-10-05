# Binary recipes are written against nixpkgs, not against their packaging
# repo's particular pin, so call package.nix with the distribution's own set.
{ pkgs, src, args ? { } }:
(import ./harness-pkgs.nix pkgs).callPackage "${src}/package.nix" args
