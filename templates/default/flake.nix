{
  description = "My coding-agent distribution";
  inputs.agent-distro.url = "github:juspay/agent-distro";
  outputs = { agent-distro, ... }:
    agent-distro.lib.mkFlake {
      profile = ./agent-distro.nix;
      # The updater installs only what this cache holds and never compiles.
      # This is agent-distro's cache, which has none of your profile's own
      # packages: replace it with a cache your CI pushes to.
      cache = agent-distro.lib.cache;
    };
}
