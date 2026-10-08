{
  # The website at https://agent-distro.nixos.asia: one page, built from this
  # directory.
  #
  #   nix build ./doc   — the site, in result/
  #   nix run ./doc     — build it and serve it at http://localhost:8080
  #
  # `.github/workflows/pages.yaml` deploys `nix build ./doc` to GitHub Pages.
  description = "The agent-distro website";

  inputs = {
    agent-distro.url = "path:..";
    nixpkgs.follows = "agent-distro/nixpkgs";
  };

  outputs = { nixpkgs, agent-distro, ... }:
    let
      inherit (nixpkgs) lib;
      systems = import "${agent-distro}/lib/systems.nix";
      # Versions are a property of the lock, the same on every system; the
      # parent flake exposes them per system, so read one.
      versions = lib.mapAttrs (_: p: p.version) agent-distro.harnesses.x86_64-linux;
      discovered = import "${agent-distro}/lib/discover-harnesses.nix";
      meta = agent-distro.harnessMeta versions;
      harnesses = map
        (name: {
          inherit name;
          inherit (meta.${name}) title releaseNotes;
          inherit (discovered.metadata.${name}) tagline;
          # The display version, as the picker and `--list` print it.
          version = builtins.head (builtins.split "\\+" versions.${name});
        })
        discovered.ordered;
      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      site = pkgs: pkgs.callPackage ./site.nix { inherit harnesses; };
    in
    {
      packages = forAllSystems (pkgs: { default = site pkgs; });
      apps = forAllSystems (pkgs: {
        default = {
          type = "app";
          program = lib.getExe (pkgs.writeShellApplication {
            name = "serve-site";
            runtimeInputs = [ pkgs.python3 ];
            text = ''
              echo "Serving ${site pkgs} at http://localhost:8080"
              exec python3 -m http.server --bind 127.0.0.1 --directory ${site pkgs} 8080
            '';
          });
        };
      });
      checks = forAllSystems (pkgs: { site = site pkgs; });
    };
}
