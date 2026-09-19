# agent-distro

A Nix framework that turns a profile of [Agent Plugins](https://agent-plugins.org)
and an optional LiteLLM gateway into Oh My Pi, Codex, and Claude Code launchers.
Use the vanilla launchers with your own provider, or publish a distribution
with your own plugins. Extracted from [juspay/AI](https://github.com/juspay/AI),
its first consumer.

## Quick start

```sh
nix run github:juspay/agent-distro           # choose a harness
nix run github:juspay/agent-distro#omp
nix run github:juspay/agent-distro#codex
nix run github:juspay/agent-distro#claude
AI_HARNESS=omp nix run github:juspay/agent-distro -- --version
```

Supported systems: `x86_64-linux`, `aarch64-linux`, and `aarch64-darwin`.

## Build your own distribution

```sh
mkdir my-distribution && cd my-distribution
nix flake init -t github:juspay/agent-distro
```

Point `my-skills` at your Agent Plugins repository and edit `profile.nix`:

| Field | Meaning |
| --- | --- |
| `name` | Distribution identifier; Codex marketplace is `<name>-ai` |
| `description` | Text shown by the harness picker |
| `plugins` | List of directories containing `plugin.json` and `skills/<name>/SKILL.md`, optionally `mcp.json` |
| `gateway` | `null`, or `{ url; keyEnv; models = { large; small; }; keyHint; }` for a LiteLLM proxy |

The template includes a gateway example; `agent-distro.profiles.vanilla` is the
reference profile shape. Commit `flake.lock` to pin your build.

```nix
agent-distro.lib.mkFlake { profile; systems ? [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ]; }
# → packages.<system>.{default,omp,codex,claude} and matching apps

agent-distro.lib.mkLaunchers { pkgs; profile; }
# → { omp; codex; claude; picker; }
```

`mkFlake` returns only `packages` and `apps`; add other outputs with `//`.
For NixOS, with your distribution bound as `distro`:

```nix
environment.systemPackages = with distro.packages.${system}; [ omp codex claude ];
```

`AI_GATEWAY=0 nix run .#omp` skips gateway initialization while keeping plugins.
It preserves existing settings: choose personal models in OMP if you previously
used gateway defaults. Codex and Claude Code always use their own login.

## Design

A **profile** is harness-independent data. A **harness** is the agent application.
A **plugin** is a portable Agent Plugins directory. A **gateway** is an optional
LiteLLM proxy used only by OMP.

- **OMP:** passes plugins as `-e` roots, composing with user extensions. A gateway
  prompts for its key, sets the LiteLLM environment, and fills absent model roles
  in user YAML while preserving existing values and comments.
- **Codex:** registers a store-built marketplace and installs plugins when its
  store path changes. Steady launches preserve disabled/removed plugins; a new
  build reinstalls them. Unrelated settings, credentials, and sessions persist.
  Vanilla skips registration entirely.
- **Claude Code:** translates manifests and copies skills/MCP configuration into
  self-contained plugin roots, passed with `--plugin-dir` for that session.
  Extra user plugins compose with them; no persistent installation is needed.

Plugin MCP commands must be available on `PATH`.

## Checks and updates

```sh
nix build .#default .#omp .#codex .#claude
nix flake check
just test              # offline NixOS VM tests; Linux with KVM
just test-template
python3 .github/scripts/test-update-flake.py
```

Daily CI advances OMP's release tag, updates the root lock, then updates
`test/flake.lock` against this checkout. It opens a dependency pull request,
approves the runs GitHub holds back for automation-created pull requests, and
squash-merges once the Linux/macOS builds and the VM and template checks pass —
the same checks `Require CI on main` requires. Consumers update with
`nix flake update agent-distro`.

For manual updates, advance `oh-my-pi.url` first, run `nix flake update`, then
`bash test/update-lock.sh`.

Consumers can import `test/lib.nix { pkgs; launchers; profile; }` and select
`omp`, `codex`, `claude`, and `picker`. Gateway tests (`gateway`, `gatewayEnv`)
and plugin rebuild tests (`ompPlugins`, `codexPlugins`, `claudePlugins`) are
separate attributes; rebuild tests additionally take `mkLaunchers`. Select
plugin rebuild tests only for nonempty skill plugins.
