# Preserve upstream's lock and source revision, including version suffixes.
{ pkgs, src }:
(import (import ./npins).flake-compat {
  src = src // { rev = src.revision; shortRev = builtins.substring 0 7 src.revision; };
}).defaultNix.packages.${pkgs.stdenv.hostPlatform.system}.default
