{ pkgs }: import ../../lib/flake-source.nix {
  inherit pkgs;
  src = (import ./npins).oh-my-pi;
}
