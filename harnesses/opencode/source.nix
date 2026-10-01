{ pkgs }:
let
  upstream = import ../../lib/flake-source.nix {
    inherit pkgs;
    src = (import ./npins).opencode;
  };
in
if pkgs.stdenv.hostPlatform.isDarwin then
  upstream.overrideAttrs (old: {
    nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ [ pkgs.darwin.sigtool ];
  })
else upstream
