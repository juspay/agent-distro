# agent-distro

**Your team's coding agents, in one command.** Package your skills, MCP servers,
and model gateway once, and run them in every [harness](./harnesses).

```sh
nix run github:juspay/agent-distro
```

![Picking a harness from the list and landing in it](./doc/demo.gif)

- **Nothing to install.** Nix fetches the agent you pick; arguments after `--`
  go straight to it.
- **Always current.** Harnesses are updated daily, and an update lands only
  after the Linux/macOS builds and the NixOS VM tests pass.
- **Write once.** One [Agent Plugins](https://agent-plugins.org) directory works
  in every harness; the per-harness translation is done for you.
- **Composes with your setup.** Your own plugins, settings, credentials, and
  sessions stay in place.
- **Make it yours.** `nix flake init -t github:juspay/agent-distro` starts a
  distribution with your plugins and, optionally, your LiteLLM gateway.

## Quick start

```sh
nix run github:juspay/agent-distro                     # pick from the list
AI_HARNESS=claude nix run github:juspay/agent-distro   # skip the list
```

To keep the agents installed and updated daily, see [Install](#install).

The list shows every profile's harnesses, the default profile's rows first:

```
❯ vanilla  Oh My Pi
  vanilla  Codex
  vanilla  Claude Code
  vanilla  OpenCode
  vanilla  OpenCode v2
  vanilla  Pi
  juspay   Oh My Pi
  juspay   Codex
  juspay   Claude Code
  juspay   OpenCode
  juspay   OpenCode v2
  juspay   Pi
```

| Variable | Values | Effect |
| --- | --- | --- |
| `AI_HARNESS` | a directory under `harnesses/` | Launches that harness without the list; required in scripts and non-interactive shells |
| `AI_PROFILE` | a directory under `profiles/` | Chooses the profile, defaulting to the one `registry.nix` names; on its own, narrows the list to that profile |
| `AI_GATEWAY` | `0` | Keeps the plugins but skips gateway initialization |

Narrowed to one profile, the list needs no profile column and gets the
profile's description as a header:

```
Juspay skills + Kolu, via Juspay's LiteLLM gateway

❯ Oh My Pi
  Codex
  Claude Code
  OpenCode
  OpenCode v2
  Pi
```

Escape or ctrl-c leaves the list.

Supported systems: `x86_64-linux`, `aarch64-linux`, and `aarch64-darwin`.

This flake names a binary cache in its `nixConfig`. Pass `--accept-flake-config`
to use it; without it, Oh My Pi is built from source.

## Install

Puts every harness on your `PATH` and updates them daily at
12:00 UTC, an hour after upstream's update. With Home Manager:

```nix
{
  imports = [ inputs.agent-distro.homeManagerModules.default ];
  services.agent-distro = {
    enable = true;
    profile = "juspay"; # default: vanilla
  };
}
```

Without Home Manager, update by hand:

```sh
nix profile install github:juspay/agent-distro#juspay
nix profile upgrade juspay
```

Add the binary cache to your NixOS or nix-darwin configuration; without it,
every update builds Oh My Pi from source:

```nix
nix.settings.extra-substituters = [ "https://cache.nixos.asia/oss" ];
nix.settings.extra-trusted-public-keys = [ "oss:KO872wNJkCDgmGN3xy9dT89WAhvv13EiKncTtHDItVU=" ];
```

Updates not arriving? `systemctl --user status agent-distro-update`; run manually with `systemctl --user start agent-distro-update`. Each run logs one line saying what it did: on Linux `journalctl --user -u agent-distro-update` shows it, and on macOS it lands in `~/.local/state/agent-distro/<source>/update.log`.

## Build your own distribution

```sh
mkdir my-distribution && cd my-distribution
nix flake init -t github:juspay/agent-distro
```

Point `my-skills` at your Agent Plugins repository and edit `profile.nix`:

| Field | Meaning |
| --- | --- |
| `name` | Distribution identifier; Codex marketplace is `<name>-ai` |
| `description` | Header above the picker's list |
| `plugins` | List of [Agent Plugins](https://agent-plugins.org/specification/) directories: a `plugin.json` manifest, with optional `skills/<name>/SKILL.md` and `mcp.json` |
| `gateway` | `null`, or `{ url; keyEnv; models = { large; small; }; keyHint; }` for a LiteLLM proxy |
| `packages` | Optional `pkgs: [ … ]`: commands the plugins' MCP servers name, put first on `PATH` for every harness |

An MCP server that a plugin declares by bare command, such as
`"command": "mcp-nixos"`, is found on `PATH`. List its package in `packages`
and it is built, or fetched from a binary cache, together with the launcher, so
the server starts at once instead of being downloaded when the agent first
asks for it, and every user runs the version the build pinned.

The template includes a gateway example; `agent-distro.profiles.vanilla` is the
reference profile shape. Commit `flake.lock` to pin your build. Your team then
runs `nix run github:<you>/my-distribution`, and updates with
`nix flake update agent-distro`.

```nix
agent-distro.lib.mkFlake { profile; systems ? [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ]; }
# → packages.<system>: every harness, default picker, and <profile.name> bundle
#   apps.<system>: every harness and default picker; homeManagerModules.default

agent-distro.lib.mkLaunchers { pkgs; profile; }
# → every harness launcher, plus picker and bundle
```

A single-profile distribution draws the narrowed list above — one profile's
rows under its description; `mkFlake` gives you the individual launchers and a
bundle named after the profile, with the picker as its `default`.

`mkFlake` returns `packages`, `apps`, and `homeManagerModules`; add other
outputs with `//`.
For NixOS, with your distribution bound as `distro`:

```nix
environment.systemPackages = [ distro.packages.${system}.my-profile ];
```

`AI_GATEWAY=0 nix run .#omp` skips gateway initialization while keeping plugins.
It preserves existing settings: choose personal models in OMP or Pi if you previously
used gateway defaults. Codex and Claude Code always use their own login.

## Profiles in this repository

| Profile | What it is |
| --- | --- |
| `vanilla` (default) | Upstream harnesses with your own provider; no plugins, no gateway |
| `juspay` | Juspay skills + Kolu, via Juspay's LiteLLM gateway |

<details>
<summary>Using the Juspay profile</summary>

```sh
AI_PROFILE=juspay nix run github:juspay/agent-distro
AI_PROFILE=juspay AI_HARNESS=omp nix run github:juspay/agent-distro -- --version
```

`AI_PROFILE=juspay` adds Juspay's skills and Kolu, and runs OMP, Pi, and OpenCode against
Juspay's LiteLLM gateway, prompting for `LITELLM_API_KEY` unless it is
exported; create a key at
[grid.ai.juspay.net/dashboard](https://grid.ai.juspay.net/dashboard) (Juspay VPN
required). `AI_GATEWAY=0` keeps the plugins but skips gateway initialization.
Codex and Claude Code always use their own login. Kolu's MCP server needs `kolu`
on `PATH`. The profile supplies `mcp-nixos` itself, at its latest release.

</details>

A profile is a directory under `profiles/`:

```
profiles/
  registry.nix          # { default = "<name>"; } — the profile the list opens on
  <name>/profile.nix    # { name; description; plugins; gateway; packages; }
  <name>/npins/         # optional: the profile's pinned plugin and package sources
```

Profiles are discovered from the directory listing, so adding one is adding a
directory — nothing in `flake.nix` names them. `profile.nix` is a plain attrset
— `packages` is its one function, since only the builder has a package set —
whose `name` must match its directory, and it pins its own sources with
[npins](https://github.com/andir/npins):

```nix
let sources = import ./npins;
in { name = "example"; plugins = [ sources.skills ]; /* … */ }
```

npins rather than flake inputs, because the top-level `flake.lock` is inherited
by everyone who builds on `lib.mkFlake`, and no distribution's plugins belong
there. Add a source with
`npins --directory profiles/<name>/npins add github <owner> <repo>`, which
follows the repository's releases, or with `--branch main` to follow a branch.
The daily update advances every profile's pins alongside the harnesses: a
release pin to the latest release, a branch pin to its head.

## How it works

A **profile** is harness-independent data. A **harness** is the agent application.
A **plugin** is a portable Agent Plugins directory. A **gateway** is an optional
LiteLLM proxy used by OMP, Pi, and OpenCode.

Harness design notes live in each directory under [harnesses/](./harnesses).

Every plugin is read once, harness-independently, against Agent Plugins 1.0.0.
An invalid manifest fails the build with a message naming the field; skipped
skills, disabled `mcp.json` files and invalid server entries are reported in
the build log, as the spec's failure boundaries require. A bare MCP `command` is
found on `PATH`: the profile's `packages` first, then the user's own. A `./`
command runs from the plugin.

One known gap: Claude Code expands `${VAR}` in a remote server's `url` and
`headers`, which the spec forbids. Those values cannot go through a launcher, so
a remote server whose URL or headers contain `${` reaches Claude Code as is.

Profiles share each harness's own home directory, so what OMP and Codex persist
outlives the profile that wrote it: a Codex marketplace registered by one
profile is still registered when you launch `vanilla`, and so are the model
roles a gateway filled into OMP's config. Claude Code's plugins last only for
the session.

## Development

```sh
nix build .#default    # the picker, and through it every profile's launchers
nix flake check
just test              # offline NixOS VM tests; Linux with KVM
just test-template
just demo              # re-record doc/demo.gif
python3 .github/scripts/test-update-flake.py
```

Daily CI runs `.github/scripts/update-sources.sh`, which discovers npins
directories under `profiles/`, `harnesses/`, and `lib/`, and runs each harness's
`update.py`. CI then updates the root and test locks. The update report reads
resolved versions and each harness's release-note metadata.

CI pushes realised paths to the OSS cache (`ATTIC_TOKEN` is needed except on
fork PRs). The daily update PR merges only after the required Linux/macOS builds
and VM/template checks pass. The update workflow approves runs GitHub holds
back for automation-created pull requests and squash-merges after the checks
required by `Require CI on main` pass. Superseded PR runs are cancelled.
Consumers run `nix flake update agent-distro`.

For manual updates, run `bash .github/scripts/update-sources.sh`,
`nix flake update`, and then `bash test/update-lock.sh`.

Consumers can import `test/lib.nix { pkgs; launchers; profile; features; }`.
Checks are selected by required features (`plugins`, `gateway`, `kolu`, `spec`)
from each harness's metadata; `picker` is shared. Rebuild and gateway checks
also accept `mkLaunchers`. Select plugin rebuild checks only for nonempty skill
plugins. The test flake covers vanilla, Juspay, and spec fixtures, plus `registry`
(the picker over the whole profile registry) and `reader` (plugin-reader checks
without a VM).

## Adding a harness

Create `harnesses/<name>/` with four files: `meta.nix` (title, order,
`releaseNotes = version: URL`, and checks), `default.nix` (the adapter accepting
`{ pkgs, plugins, gateway, package, profileName }`), `source.nix` (`{ pkgs }` to
package), and `README.md` (design notes). Put pins in `npins/`, scripts in `tests/`, and an
optional custom updater in `update.py`. Nothing outside this directory needs
registration: the picker, bundles, outputs, reserved names, checks, and daily
report all discover it. The explicit `profileName` argument supports
profile-specific registration, such as Codex’s marketplace name.

Checks declare `{ name; script; requires ? []; packages ? []; env ? {}; diskSize ? null; }`.
Packages can name `updated`, `upstream`, `koluFixture`, or `recordFixture`.
`script` is VM-driver Python. Use `import ../../test/guest-script.nix ./tests/check.py`
to run a guest script as the unprivileged VM user. Gateway checks receive the shared fake service and
launchers configured against it. `mkLaunchers` also accepts a `sources = name: pkgs: …`
hook for package fixtures.
