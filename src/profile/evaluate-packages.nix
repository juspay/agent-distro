# The `packages` of a plugin.json profile's
# `extensions."asia.nixos.agent-distro"`, as data for src/profile/resolve.ts:
# run by `nix eval --json --impure` under restrict-eval, given `attributes`
# (nixpkgs attribute paths), `nixpkgs` and `system`.
#
# Each attribute is a path into the nixpkgs the launcher was built with, for
# `system`. An attribute nixpkgs does not have is an error
# naming it, in the launcher's words rather than nixpkgs'.
{ attributes, nixpkgs, system }:
let
  # Nothing from the user's nixpkgs configuration or overlays.
  pkgs = import (/. + nixpkgs) { inherit system; config.allowUnfree = true; overlays = [ ]; };
  package = attribute:
    let
      path = pkgs.lib.splitString "." attribute;
      drv =
        if pkgs.lib.hasAttrByPath path pkgs then pkgs.lib.getAttrFromPath path pkgs
        else throw "profile package: nixpkgs has no attribute `${attribute}`";
      bin = pkgs.lib.getBin drv;
    in
    {
      name = drv.name;
      drvPath = drv.drvPath;
      out = "${bin}";
      bin = "${bin}/bin";
    };
in
map package attributes
