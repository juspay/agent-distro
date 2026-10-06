# The one package set every harness recipe is called with. Upstream locks each
# pin a different nixpkgs; honouring them costs a tarball download and a full
# instantiation per harness, which dominated both cold and warm evaluation.
# Some harnesses are unfree, so reuse `pkgs` only when it already allows that.
pkgs:
if pkgs.config.allowUnfree or false then pkgs
else
  import pkgs.path {
    inherit (pkgs.stdenv.hostPlatform) system;
    inherit (pkgs) overlays;
    config = pkgs.config // { allowUnfree = true; };
  }
