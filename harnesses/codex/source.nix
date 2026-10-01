{ pkgs }: import ../../lib/binary-source.nix {
  inherit pkgs;
  src = (import ./npins).codex-cli-nix;
  args.runtime = "native";
}
