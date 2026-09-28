let
  sources = import ./npins;
in
{
  name = "juspay";
  description = "Juspay skills + Kolu, via Juspay's LiteLLM gateway";
  plugins = [ sources.skills "${sources.kolu}/agent-plugin" ];
  # nixpkgs builds it, so it arrives from the binary cache with the launcher
  # rather than being fetched when the agent first starts its MCP servers.
  packages = pkgs: [ pkgs.mcp-nixos ];
  gateway = {
    url = "https://grid.ai.juspay.net";
    keyEnv = "LITELLM_API_KEY";
    models = { large = "open-large"; small = "open-fast"; };
    keyHint = "Requires Juspay VPN to access the dashboard";
  };
}
