let
  sources = import ./npins;
  # The source is the latest release, which npins tracks and the daily update
  # advances; the recipe is the release's own, because what a release needs
  # changes with it. Its flake exports that recipe for a caller's package set,
  # and reaching it needs none of the flake's inputs — which would cost every
  # launch a second nixpkgs — so its outputs get only the plumbing it touches.
  mcp-nixos = pkgs:
    let
      flake = (import "${sources.mcp-nixos}/flake.nix").outputs {
        self = flake;
        nixpkgs = { inherit (pkgs) lib; };
        flake-parts.lib.mkFlake = _: module: module.flake;
      };
    in
    flake.lib.mkMcpNixos { inherit pkgs; };
in
{
  name = "juspay";
  description = "Juspay skills + Kolu, via Juspay's LiteLLM gateway";
  plugins = [ sources.skills "${sources.kolu}/agent-plugin" ];
  # Built with the launcher, so it arrives from the binary cache instead of
  # being fetched when the agent first starts its MCP servers.
  packages = pkgs: [ (mcp-nixos pkgs) ];
  gateway = {
    url = "https://grid.ai.juspay.net";
    keyEnv = "LITELLM_API_KEY";
    models = { large = "open-large"; small = "open-fast"; };
    keyHint = "Requires Juspay VPN to access the dashboard";
  };
}
