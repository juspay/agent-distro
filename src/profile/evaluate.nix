# One `agent-distro.nix`, as data for src/profile/resolve.ts: run by
# `nix eval --json --impure` under restrict-eval, given `file`, `nixpkgs` and
# `system`.
#
# Plugin paths stay where they are (a checkout is read in place, not copied
# into the store); a string is a path when absolute, else a flake reference
# the resolver fetches. Packages are evaluated against the nixpkgs the
# launcher was built with, for `system`; with `nixpkgs` null, a profile with
# packages has `packages = null`, for the resolver to fetch nixpkgs and ask
# again.
{ file, nixpkgs, system }:
let
  profile = import (/. + file);
  plugin = entry:
    if builtins.isPath entry then toString entry
    else if builtins.isString entry then entry
    else throw "${file}: each entry of `plugins` must be a path or a flake reference string.";
  # Nothing from the user's nixpkgs configuration or overlays.
  pkgs = import (/. + nixpkgs) { inherit system; config.allowUnfree = true; overlays = [ ]; };
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
  # Exported before the harness starts, and merged into its own configuration:
  # both opaque here, validated by the resolver.
  env = profile.env or { };
  settings = profile.settings or { };
  # Attributes the resolver no longer reads but warns about, so a profile
  # written for an older agent-distro says so on every launch, not only the
  # one that evaluated it.
  deprecated = if profile ? gateway then [ "gateway" ] else [ ];
  packages =
    if !(profile ? packages) then [ ]
    else if nixpkgs == null then null
    else map package (profile.packages pkgs);
}
