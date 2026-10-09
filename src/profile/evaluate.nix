# One `agent-distro.nix`, as data for src/profile/resolve.ts: run by
# `nix eval --json --impure`, with `file` and `nixpkgs` from its environment.
#
# Plugin paths stay where they are (a checkout is read in place, not copied
# into the store); a string is a path when absolute, else a flake reference
# the resolver fetches. Packages are evaluated against the nixpkgs the
# launcher was built with, and only when the profile has any.
{ file, nixpkgs }:
let
  profile = import (/. + file);
  plugin = entry:
    if builtins.isPath entry then toString entry
    else if builtins.isString entry then entry
    else throw "${file}: each entry of `plugins` must be a path or a flake reference string.";
  pkgs = import (/. + nixpkgs) { config.allowUnfree = true; };
  package = drv:
    let bin = pkgs.lib.getBin drv; in
    {
      name = drv.name;
      drvPath = drv.drvPath;
      out = "${bin}";
      bin = "${bin}/bin";
    };
in
{
  inherit (profile) name;
  description = profile.description or "";
  plugins = map plugin (profile.plugins or [ ]);
  gateway = profile.gateway or null;
  packages = if profile ? packages then map package (profile.packages pkgs) else [ ];
}
