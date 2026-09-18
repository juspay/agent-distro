{
  description = "My coding-agent distribution";
  inputs = {
    agent-distro.url = "github:juspay/agent-distro";
    # Replace with your Agent Plugins directory: root plugin.json and
    # skills/<name>/SKILL.md (plus optional mcp.json).
    my-skills = { url = "github:juspay/skills"; flake = false; };
  };
  outputs = { agent-distro, my-skills, ... }:
    agent-distro.lib.mkFlake {
      profile = import ./profile.nix { inherit my-skills; };
    };
}
