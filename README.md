<img src="doc/logo.svg" width="96" alt="agent-distro logo">

# agent-distro

**Your team's coding agents, in one command.** Package your skills, MCP servers,
and model gateway once, and run them in every harness.

```sh
nix run github:juspay/agent-distro
```

Installs keep themselves up to date from the project's binary cache and never
compile. A Linux machine whose Nix will not trust that cache — a shared host
where you are not a trusted user — updates too, from the content-addressed
bundles published for every revision; a Mac needs the cache key or a trusted
user, because a rewritten Mach-O does not run on arm64 macOS.

Everything else is on the website, **<https://agent-distro.nixos.asia>**:

- [Quick start](https://agent-distro.nixos.asia/#quick-start)
- [Install and keep updated](https://agent-distro.nixos.asia/#install)
- [The binary cache](https://agent-distro.nixos.asia/#binary-cache)
- [Build your own distribution](https://agent-distro.nixos.asia/#build-your-own-distribution)
- [Profiles](https://agent-distro.nixos.asia/#profiles)
- [Harnesses](https://agent-distro.nixos.asia/#harnesses)
- [How it works](https://agent-distro.nixos.asia/#how-it-works)
- [Development](https://agent-distro.nixos.asia/#development)
- [Adding a harness](https://agent-distro.nixos.asia/#adding-a-harness)
