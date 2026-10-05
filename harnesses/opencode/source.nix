# Upstream's build.ts needs codesign and codesign_allocate, absent from its stdenvNoCC.
{ pkgs }:
let
  src = (import ./npins).opencode;
  # Upstream's per-platform node_modules hashes hold only for the bun its lock
  # pins (the shared nixpkgs' newer bun changes aarch64-linux's), so build with
  # that bun: its recipe from the locked nixpkgs source, called with the
  # shared package set rather than instantiating a second nixpkgs.
  lock = builtins.fromJSON (builtins.readFile "${src}/flake.lock");
  lockedNixpkgs = builtins.fetchTree lock.nodes.${lock.nodes.${lock.root}.inputs.nixpkgs}.locked;
  bun = pkgs.callPackage "${lockedNixpkgs}/pkgs/by-name/bu/bun/package.nix" { };
  upstream = (import ../../lib/flake-source.nix { inherit pkgs src; }).override (old: {
    inherit bun;
    node_modules = old.node_modules.override { inherit bun; };
  });
in
if pkgs.stdenv.hostPlatform.isDarwin then
  upstream.overrideAttrs (old: {
    nativeBuildInputs = old.nativeBuildInputs ++ [ pkgs.darwin.sigtool pkgs.darwin.cctools ];
  })
else upstream
