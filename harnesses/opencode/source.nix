# Upstream's build.ts needs codesign and codesign_allocate, absent from its stdenvNoCC.
{ pkgs }:
let
  upstream = import ../../lib/flake-source.nix {
    inherit pkgs;
    src = (import ./npins).opencode;
  };
in
if pkgs.stdenv.hostPlatform.isDarwin then
  upstream.overrideAttrs (old: {
    nativeBuildInputs = old.nativeBuildInputs ++ [ pkgs.darwin.sigtool pkgs.darwin.cctools ];
  })
else upstream
