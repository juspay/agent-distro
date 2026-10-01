# Binary recipes also depend on their packaging repo's package set. Retain it
# while calling package.nix directly, without evaluating the packaging flake.
{ pkgs, src }:
let
  lock = builtins.fromJSON (builtins.readFile "${src}/flake.lock");
  pinned = lock.nodes.${lock.nodes.${lock.root}.inputs.nixpkgs}.locked;
in
import (builtins.fetchTree pinned) {
  inherit (pkgs.stdenv.hostPlatform) system;
  config.allowUnfree = true;
}
