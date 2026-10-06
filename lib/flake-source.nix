# Evaluate an upstream flake from its own lock, preserving its source revision
# (and so version suffixes), except that every nixpkgs node in the lock is
# replaced by the distribution's package set: one nixpkgs to fetch and
# instantiate instead of one per harness. Otherwise this is flake-compat's
# lock walk, limited to the input types upstream locks use.
{ pkgs, src }:
let
  inherit (pkgs.stdenv.hostPlatform) system;
  harnessPkgs = import ./harness-pkgs.nix pkgs;

  # Shaped like the nixpkgs flake as far as upstream recipes reach into it.
  # Other systems stay lazy; only the host's is ever forced.
  nixpkgs = {
    _type = "flake";
    inherit (harnessPkgs) lib;
    outPath = harnessPkgs.path;
    legacyPackages = harnessPkgs.lib.genAttrs
      [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ]
      (s: if s == system then harnessPkgs else import harnessPkgs.path {
        system = s;
        config.allowUnfree = true;
      });
  };
  isNixpkgs = locked:
    locked.type or null == "github"
    && harnessPkgs.lib.toLower locked.owner == "nixos"
    && locked.repo == "nixpkgs";

  lock = builtins.fromJSON (builtins.readFile "${src}/flake.lock");
  rootSource = src // {
    outPath = "${src}";
    rev = src.revision;
    shortRev = builtins.substring 0 7 src.revision;
  };

  # A 'follows' input is a path from the root; anything else is a node name.
  resolve = spec: if builtins.isList spec then follow lock.root spec else spec;
  follow = node: path:
    if path == [ ] then node
    else follow (resolve lock.nodes.${node}.inputs.${builtins.head path}) (builtins.tail path);

  nodes = builtins.mapAttrs
    (key: node:
      if key != lock.root && isNixpkgs node.locked then nixpkgs
      else
        let
          sourceInfo =
            if key == lock.root then rootSource
            else builtins.fetchTree (removeAttrs node.locked [ "dir" ]);
          outPath = sourceInfo.outPath
            + (if node.locked.dir or "" == "" then "" else "/${node.locked.dir}");
          inputs = builtins.mapAttrs (_: spec: nodes.${resolve spec}) (node.inputs or { });
          flake = import "${outPath}/flake.nix";
          result = flake.outputs (inputs // { self = result; })
            // sourceInfo // { inherit outPath inputs sourceInfo; _type = "flake"; };
        in
        if node.flake or true then result else sourceInfo // { inherit outPath; })
    lock.nodes;
in
nodes.${lock.root}.packages.${system}.default
