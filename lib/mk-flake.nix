# Bind upstream inputs once; consumers add their own outputs with //.
{ nixpkgs, oh-my-pi, codex-cli, claude-code }:
let
  mkLaunchers = import ./mk-launchers.nix { inherit oh-my-pi codex-cli claude-code; };
in
{ profile, systems ? [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ] }:
let
  packages = nixpkgs.lib.genAttrs systems (system:
    let
      launchers = mkLaunchers { pkgs = import nixpkgs { inherit system; }; inherit profile; };
    in
    { inherit (launchers) omp codex claude; default = launchers.picker; });
in
{
  inherit packages;
  apps = nixpkgs.lib.mapAttrs
    (_: nixpkgs.lib.mapAttrs (_: package: {
      type = "app";
      program = nixpkgs.lib.getExe package;
    }))
    packages;
}
