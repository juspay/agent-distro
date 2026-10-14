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
  # Variables every launch exports, and settings for the harnesses that read
  # them. A `secret = true` variable is asked for when it is not already set,
  # and never written to a file.
  # env = {
  #   LITELLM_BASE_URL = "https://llm.example.org";
  #   LITELLM_API_KEY = { secret = true; hint = "Get a key from your gateway administrator."; };
  # };
  # settings.omp.modelRoles = { default = "litellm/large"; slow = "litellm/large"; task = "litellm/large"; smol = "litellm/fast"; };
  # settings.opencode = {
  #   providers.litellm = { package = "@opencode/ai/providers/openai-compatible"; settings.baseURL = "https://llm.example.org/v1"; };
  #   model = "litellm/large";
  #   agents.title.model = "litellm/fast";
  # };
}
