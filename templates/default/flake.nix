{
  description = "My coding-agent distribution";
  inputs = {
    agent-distro.url = "github:juspay/agent-distro";
    # Replace with your Agent Plugins directory: root plugin.json, plus
    # optional skills/<name>/SKILL.md and mcp.json.
    my-skills = { url = "github:juspay/skills"; flake = false; };
  };
  outputs = { agent-distro, my-skills, ... }:
    agent-distro.lib.mkFlake {
      profile = import ./profile.nix { inherit my-skills; };
      # The updater installs only what this cache holds and never compiles.
      # This is agent-distro's cache, which has none of your profile's own
      # packages: replace it with a cache your CI pushes to.
      cache = agent-distro.lib.cache;
    };
}
