<img src="doc/logo.svg" width="96" alt="agent-distro logo">

# agent-distro

**An Agent Plugin in your repository is all the setup your coding agents need.**
agent-distro runs Oh My Pi, Claude Code, Codex, OpenCode and Pi, and each picks up
the repository's `plugin.json` — skills, MCP servers, packages, environment,
harness settings — the moment you launch it there.

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "my-repo"
}
```

```sh
nix run github:juspay/agent-distro
```

Installs keep themselves up to date from the project's binary cache and never
compile. A Linux machine whose Nix will not trust that cache — a shared host
where you are not a trusted user — updates too, from the content-addressed
store paths published for every revision (built with Nix 2.34.x: Nix 2.35
changed how a self-referential path is addressed, and a host on it cannot take
them); a Mac needs the cache key or a trusted user, because a rewritten Mach-O
does not run on arm64 macOS.

Everything else is on the website, **<https://agent-distro.kolu.dev>**:

- [Quick start](https://agent-distro.kolu.dev/#quick-start)
- [Install and keep updated](https://agent-distro.kolu.dev/#install)
- [The binary cache](https://agent-distro.kolu.dev/#binary-cache)
- [Package layout](https://agent-distro.kolu.dev/#package-layout)
- [Profiles](https://agent-distro.kolu.dev/#profiles)
- [Harnesses](https://agent-distro.kolu.dev/#harnesses)
- [How it works](https://agent-distro.kolu.dev/#how-it-works)
- [Development](https://agent-distro.kolu.dev/#development)
- [Adding a harness](https://agent-distro.kolu.dev/#adding-a-harness)
