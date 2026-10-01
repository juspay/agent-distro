# Upstream's build.ts runs codesign on Darwin, but its Nix recipe supplies none.
{ pkgs }:
let
  upstream = import ../../lib/flake-source.nix {
    inherit pkgs;
    src = (import ./npins).opencode;
  };
in
if pkgs.stdenv.hostPlatform.isDarwin then
  upstream.overrideAttrs (old: {
    nativeBuildInputs = old.nativeBuildInputs ++ [ pkgs.darwin.sigtool ];
  })
else upstream
