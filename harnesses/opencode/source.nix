# Upstream's build.ts needs codesign and codesign_allocate, absent from its stdenvNoCC.
{ pkgs }:
let
  src = (import ./npins).opencode;
  # Upstream's per-platform node_modules hashes hold only for the bun its lock
  # pins (the shared nixpkgs' newer bun changes aarch64-linux's). update.py
  # vendors that bun's recipe, so it is called with the shared package set
  # without fetching the locked nixpkgs.
  lock = builtins.fromJSON (builtins.readFile "${src}/flake.lock");
  lockedRev = lock.nodes.${lock.nodes.${lock.root}.inputs.nixpkgs}.locked.rev;
  bun =
    if pkgs.lib.hasPrefix "# NixOS/nixpkgs@${lockedRev}:" (builtins.readFile ./bun.nix)
    then pkgs.callPackage ./bun.nix { }
    else throw "harnesses/opencode/bun.nix is not from nixpkgs ${lockedRev}, which OpenCode's lock pins; run harnesses/opencode/update.py.";
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
