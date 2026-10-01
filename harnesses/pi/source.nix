{ pkgs }: import ../../lib/binary-source.nix {
  inherit pkgs;
  src = (import ./npins).pi-nix;
}
