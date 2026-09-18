{
  description = "Vanilla launcher integration tests";
  inputs = {
    agent-distro.url = "github:juspay/agent-distro";
    nixpkgs.follows = "agent-distro/nixpkgs";
  };
  outputs = { nixpkgs, agent-distro, ... }:
    let
      pkgs = nixpkgs.legacyPackages.x86_64-linux;
      profile = { name = "vanilla"; description = "Upstream harnesses with your own provider"; plugins = [ ]; gateway = null; };
      packages = agent-distro.packages.x86_64-linux;
      tests = import ./lib.nix {
        inherit pkgs profile;
        launchers = { inherit (packages) omp codex claude; picker = packages.default; };
      };
    in
    {
      checks.x86_64-linux = { inherit (tests) omp codex claude picker; };
    };
}
