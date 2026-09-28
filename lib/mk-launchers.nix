# Bind upstream binaries once; consumers supply their package set and profile.
{ oh-my-pi, codex-cli, claude-code }:
{ pkgs, profile }:
let
  inherit (pkgs) lib;
  system = pkgs.stdenv.hostPlatform.system;
  inherit (profile) plugins;
  gateway = profile.gateway or null;

  # What a plugin's MCP servers name by bare command. They reach every harness
  # the same way, so they go on PATH here, around the adapters, rather than
  # once inside each; they come first, so a launch runs what the build pinned.
  packages = (profile.packages or (_: [ ])) pkgs;
  withPackages = launcher:
    if packages == [ ] then launcher
    else
      pkgs.writeShellApplication {
        inherit (launcher) name;
        runtimeInputs = packages;
        derivationArgs = lib.optionalAttrs (launcher ? version) { inherit (launcher) version; };
        text = ''
          exec ${lib.getExe launcher} "$@"
        '';
      };

  omp = withPackages (pkgs.callPackage ../adapters/omp {
    inherit plugins gateway;
    omp = oh-my-pi.packages.${system}.default;
  });
  codex = withPackages (pkgs.callPackage ../adapters/codex {
    inherit plugins;
    marketplaceName = "${profile.name}-ai";
    codex = codex-cli.packages.${system}.default;
  });
  claude = withPackages (pkgs.callPackage ../adapters/claude {
    inherit plugins;
    claude = claude-code.packages.${system}.default;
  });
in
{
  inherit omp codex claude;
  picker = pkgs.callPackage ../adapters/picker.nix {
    default = profile.name;
    profiles.${profile.name} = { inherit profile; launchers = { inherit omp codex claude; }; };
  };
}
