{ pkgs }:
let
  sources = import ./npins;
  shared = import ../../lib/npins;
  pin = (builtins.fromJSON (builtins.readFile ./npins/sources.json)).pins.oh-my-pi;
  # flake-compat honours the upstream lock and its source revision metadata.
  src = sources.oh-my-pi // { rev = pin.revision; shortRev = builtins.substring 0 7 pin.revision; };
in
(import shared.flake-compat { inherit src; }).defaultNix.packages.${pkgs.stdenv.hostPlatform.system}.default
