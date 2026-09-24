# The Juspay distribution, moved here from juspay/AI so that one repository and
# one daily update cover the framework and the plugins together.
let
  # Pinned with npins rather than flake inputs: a flake input would put Juspay's
  # plugin sources in the top-level flake.lock, which every consumer of this
  # framework locks in turn. npins keeps the pins inside the profile that uses
  # them, and `builtins.fetchTarball` with a hash stays pure.
  sources = import ./npins;
in
{
  name = "juspay";
  description = "Juspay skills + Kolu, via Juspay's LiteLLM gateway";
  # juspay/skills is itself an Agent Plugins package; kolu ships one under
  # `agent-plugin/`, so only that subdirectory is a plugin root.
  plugins = [ sources.skills "${sources.kolu}/agent-plugin" ];
  gateway = {
    url = "https://grid.ai.juspay.net";
    keyEnv = "LITELLM_API_KEY";
    models = { large = "open-large"; small = "open-fast"; };
    keyHint = "Requires Juspay VPN to access the dashboard";
  };
}
