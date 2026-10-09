# The nixpkgs a launcher evaluates a profile's `packages` against, as
# src/profile/resolve.ts fetches it only when a profile has any: a locked
# reference to the flake input `pkgs` was imported from, so no launcher holds
# its ~200 MB source; for a `pkgs` from anywhere else, its store path, which
# the launchers then hold.
pkgs: nixpkgs:
let
  # narHash is base64: its +, / and = are not plain URL query characters.
  encode = builtins.replaceStrings [ "+" "/" "=" ] [ "%2B" "%2F" "%3D" ];
in
if nixpkgs != null && nixpkgs ? rev && nixpkgs ? narHash && toString pkgs.path == toString nixpkgs.outPath
then "github:NixOS/nixpkgs/${nixpkgs.rev}?narHash=${encode nixpkgs.narHash}"
else "${pkgs.path}"
