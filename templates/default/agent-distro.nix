# This repository's profile. agent-distro reads it when a harness starts in
# this repository, or anywhere with `agent-distro github:<you>/<repo>`; the
# flake builds it into a distribution of its own.
{
  name = "my-distribution";
  description = "My skills with your choice of coding agent";
  # Agent Plugins directories: this repository is one (plugin.json, skills/).
  # A plugin elsewhere is a flake reference read at launch, such as
  # "github:juspay/kolu?dir=agent-plugin".
  plugins = [ ./. ];
  # Commands your plugins' MCP servers name, put on PATH for every harness:
  # packages = pkgs: [ pkgs.mcp-nixos ];
  gateway = null;
  # To connect OMP, OpenCode and Pi to a LiteLLM gateway, replace null with:
  # {
  #   url = "https://llm.example.org";
  #   keyEnv = "LITELLM_API_KEY";
  #   models = { large = "large"; small = "fast"; };
  #   keyHint = "Get a key from your gateway administrator.";
  # };
}
