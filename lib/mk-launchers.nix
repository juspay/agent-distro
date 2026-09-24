# Bind upstream binaries once; consumers supply their package set and profile.
{ oh-my-pi, codex-cli, claude-code }:
{ pkgs, profile }:
let
  system = pkgs.stdenv.hostPlatform.system;
  inherit (profile) plugins;
  gateway = profile.gateway or null;
  omp = pkgs.callPackage ../adapters/omp {
    inherit plugins gateway;
    omp = oh-my-pi.packages.${system}.default;
  };
  codex = pkgs.callPackage ../adapters/codex {
    inherit plugins;
    marketplaceName = "${profile.name}-ai";
    codex = codex-cli.packages.${system}.default;
  };
  claude = pkgs.callPackage ../adapters/claude {
    inherit plugins;
    claude = claude-code.packages.${system}.default;
  };
in
{
  inherit omp codex claude;
  picker = pkgs.callPackage ../adapters/picker.nix {
    default = profile.name;
    profiles.${profile.name} = { inherit profile; launchers = { inherit omp codex claude; }; };
  };
}
