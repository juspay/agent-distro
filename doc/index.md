---
title: agent-distro
description: "Your team's coding agents, in one command. Package your skills, MCP servers and model gateway once, and run them in every harness."
---

## Quick start

```sh
nix run github:juspay/agent-distro                     # pick from the list
AI_HARNESS=claude nix run github:juspay/agent-distro   # skip the list
```

To keep the agents installed and updated, see [Install and keep updated](#install).

- **Systems.** `x86_64-linux`, `aarch64-linux`, and `aarch64-darwin`.
- **Binary cache.** Pass `--accept-flake-config` to use the cache this flake names;[^nixconfig] without it, Oh My Pi is built from source.

[^nixconfig]: The cache is named in the flake's `nixConfig`. The Home Manager updater in [Install](#install) handles the cache itself.

### The chooser

With several profiles, the chooser is master–detail: profiles are tabs in the header, harnesses are the list on the left, and the highlighted harness fills the panel on the right.[^chooser-rows] <kbd>←</kbd>/<kbd>→</kbd> (or <kbd>Tab</kbd>) switch profile, and nothing in the box is ever cut.

Here `vanilla/pi` is remembered from last time.[^remembered-example]

[^chooser-rows]: The active profile's name and description take a row of their own under the header. The panel shows the highlighted harness's tagline and its auth status.
[^remembered-example]: So the default profile opens, the remembered one is dotted, and switching to it lands on that harness.

```
╭─ agent-distro ───────────────────────── juspay · • vanilla ── 6 harnesses ─╮
│ juspay · Juspay skills + Kolu, via Juspay's LiteLLM gateway                │
├──────────────────────────────┬─────────────────────────────────────────────┤
│ ❯   ✓ Oh My Pi       18.7.0  │ Oh My Pi 18.7.0                             │
│     ✓ Codex         0.160.1  │ gateway or own provider · extensions        │
│     ✓ Claude Code   2.1.292  │                                             │
│     ✓ OpenCode      1.18.35  │ Signed in                                   │
│       OpenCode v2    2.0.24  │   LITELLM_API_KEY                           │
│     ✓ Pi              1.0.4  │   anthropic                                 │
│                              │   openai                                    │
├──────────────────────────────┴─────────────────────────────────────────────┤
│ / filter…                                                                  │
╰────────────────────────────────────────────────────────────────────────────╯
↑↓ jk move   ←→ profile   Enter launch   / filter   q quit
```

| Variable[^var-names] | Values | Effect |
| --- | --- | --- |
| `AI_HARNESS` | a directory under `harnesses/` | Launches that harness without the list[^non-interactive] |
| `AI_PROFILE` | a directory under `profiles/` | Chooses the profile;[^profile-default] on its own, narrows the list to that profile |
| `AI_GATEWAY` | `0` | Keeps the plugins but skips gateway initialization |
| `AGENT_DISTRO_PLUGINS` | `:`-separated plugin directories | Loads more plugins for that launch; see [Plugins at launch](#plugins-at-launch) |

[^var-names]: Names unchanged for script compatibility.
[^non-interactive]: Also usable in scripts and non-interactive shells.
[^profile-default]: Defaulting to the one `registry.nix` names.

### By name

| Command | Does |
| --- | --- |
| `agent-distro <harness>` | Launches directly |
| `agent-distro <profile> <harness>` | Selects both |
| `agent-distro <profile>` | Narrows the chooser |

For example:

```sh
agent-distro codex --version
agent-distro juspay claude --version
agent-distro juspay
agent-distro --list                      # profile harness title version, one row per line
agent-distro --list --json               # the same, as JSON (below)
```

- **Precedence.** `AI_HARNESS` and `AI_PROFILE` take precedence over positional selections.[^positional-default]
- **Passthrough.** Recognized leading names are consumed; other arguments and everything after `--` are passed to the harness unchanged.

[^positional-default]: The profile otherwise defaults to the registry default.

### One profile

Narrowed to one profile,[^narrowed] the header shows that profile's name instead of tabs, and the row under it is the same. Versions reflect the packages pinned at build time.[^no-revision]

[^narrowed]: By `agent-distro juspay`, by `AI_PROFILE`, or by being a single-profile distribution.
[^no-revision]: Shown without revision suffixes.

```
╭─ agent-distro · juspay ────────────────────────────────────── 6 harnesses ─╮
│ juspay · Juspay skills + Kolu, via Juspay's LiteLLM gateway                │
├──────────────────────────────┬─────────────────────────────────────────────┤
│ ❯   ✓ Oh My Pi       18.7.0  │ Oh My Pi 18.7.0                             │
│     ✓ Codex         0.160.1  │ gateway or own provider · extensions        │
│     ✓ Claude Code   2.1.292  │                                             │
│     ✓ OpenCode      1.18.35  │ Signed in                                   │
│       OpenCode v2    2.0.24  │   LITELLM_API_KEY                           │
│     ✓ Pi              1.0.4  │   anthropic                                 │
│                              │   openai                                    │
├──────────────────────────────┴─────────────────────────────────────────────┤
│ / filter…                                                                  │
╰────────────────────────────────────────────────────────────────────────────╯
↑↓ jk move   Enter launch   / filter   q quit
```

### Signed-in marks

`✓` marks a harness that can start without a login step; the panel beside it says what was found.[^presence] A harness with nothing to start from shows a dim `Not signed in` and no mark.[^unreadable]

| Harness | Looks at |
| --- | --- |
| Claude Code | `oauthAccount.emailAddress` in `$CLAUDE_CONFIG_DIR/.claude.json`,[^claude-default] or the name of `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` |
| Codex | the `email` claim of the OpenID token in `$CODEX_HOME/auth.json`,[^codex-claim] or `OPENAI_API_KEY` |
| Gateway harnesses | the profile's `gateway.keyEnv`, then the provider ids it also has credentials for[^both] |
| Own-provider harnesses | the ids in the harness's store,[^stores] plus the provider API-key variables it reads from the environment |

`AI_GATEWAY=0` puts a gateway harness back on its own provider. This is a launch-time fact: `--list` and `--list --json` never carry it.

[^presence]: Presence only: the picker contacts no provider and checks no token's validity or expiry.
[^unreadable]: One whose store cannot be read shows nothing at all, and no mark.
[^claude-default]: Default `~/.claude.json`.
[^codex-claim]: Read from `tokens.id_token` without checking its signature; `ChatGPT` when the claim is absent.
[^both]: The gateway and the harness's own providers are usable at once.
[^stores]: OMP's `~/.omp/agent/agent.db`, Pi's `$PI_CODING_AGENT_DIR/auth.json` (default `~/.pi/agent/auth.json`), OpenCode's `${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json`.

### Keys

| Key | Does |
| --- | --- |
| <kbd>↑</kbd>/<kbd>↓</kbd>, <kbd>j</kbd>/<kbd>k</kbd> | Move in the list |
| <kbd>←</kbd>/<kbd>→</kbd>, <kbd>Tab</kbd>/<kbd>Shift-Tab</kbd>, <kbd>h</kbd>/<kbd>l</kbd> | Switch profile (several profiles only) |
| <kbd>Enter</kbd> | Launch the highlighted harness |
| <kbd>/</kbd> | Filter the list by title or tagline |
| <kbd>Escape</kbd> (filtering) | Clear the filter, keeping the cursor on its row |
| <kbd>Escape</kbd>, <kbd>q</kbd>, <kbd>Ctrl-C</kbd> | Quit without choosing |

- **Filtering.** The filter line shows the query as typed and how many rows match.[^filter-keys]
- **Footer.** Lists only the keys that apply at that moment.
- **Colour.** Follows [`NO_COLOR`](https://no-color.org) and the terminal type.
- **Small terminals.** Small or unsupported terminals get a numbered list on stderr instead.[^small-term] One that shrinks below that once the box is up shows a notice until it grows again.[^shrink]
- **No terminal.** Without a terminal on stdin, agent-distro says which variables to set instead of drawing anything.

[^filter-keys]: <kbd>↑</kbd>/<kbd>↓</kbd> still move, <kbd>Backspace</kbd> edits, and <kbd>Enter</kbd> takes the highlighted match.
[^small-term]: `TERM` unset or `dumb`, no controlling terminal, or fewer rows or columns than the box needs.
[^shrink]: The cursor and filter are kept.

### Remembered choice

An interactive selection is remembered in `${XDG_STATE_HOME:-$HOME/.local/state}/agent-distro/last-choice`.[^state-unavailable] Next time the default profile still opens, and the remembered profile and harness are marked with `•`.[^remembered-cursor]

- **Updates it.** Every interactive choice, including `agent-distro <profile>`.
- **Never updates it.** Direct selections: `AI_HARNESS`, `agent-distro <harness>`, or `agent-distro <profile> <harness>`.

[^state-unavailable]: An unavailable state directory is silently ignored.
[^remembered-cursor]: Switching to the remembered profile puts the cursor on that harness.

### Listing as JSON

`agent-distro --list --json` prints what the chooser draws, on one line, for programs that offer the same choice (such as [kolu](https://github.com/juspay/kolu)).[^listing-type] Here it is pretty-printed, with each profile cut to one harness:

[^listing-type]: Its shape is stable, typed as `Listing` in [src/listing.ts](https://github.com/juspay/agent-distro/blob/main/src/listing.ts).

```json
{
  "profiles": [
    {
      "description": "Juspay skills + Kolu, via Juspay's LiteLLM gateway",
      "harnesses": [
        {
          "name": "claude",
          "tagline": "Anthropic login · plugin dirs per session",
          "title": "Claude Code",
          "version": "2.1.291"
        }
      ],
      "name": "juspay"
    },
    {
      "description": "Upstream harnesses with your own provider",
      "harnesses": [
        {
          "name": "claude",
          "tagline": "Anthropic login · plugin dirs per session",
          "title": "Claude Code",
          "version": "2.1.291"
        }
      ],
      "name": "vanilla"
    }
  ]
}
```

| Field | Rule |
| --- | --- |
| `profiles` | The first profile is the default |
| `harnesses` | In menu order |
| `name` | Unique at its level, free of whitespace and `/`; what `AI_PROFILE` or `AI_HARNESS` (or a positional selector) takes |
| `version` | The display version, as `--list` prints it[^plus-suffix] |

Keys within an object are sorted. `--list` takes no other arguments.[^three-agree]

[^plus-suffix]: Without the package's `+` revision suffix.
[^three-agree]: The plain `--list` and the chooser read the same value, so the three cannot disagree.

### Plugins at launch

A profile fixes the plugins its harnesses start with. Put more [Agent
Plugins](https://agent-plugins.org) directories on `AGENT_DISTRO_PLUGINS`, and
every harness loads them too, in every profile, for that launch:

```sh
AGENT_DISTRO_PLUGINS=~/src/my-plugin agent-distro claude
AGENT_DISTRO_PLUGINS=/nix/store/…-kolu/agent-plugin:~/src/my-plugin agent-distro juspay omp
```

> Unset or empty, the launchers behave exactly as they do without this feature.

- **Entries.** Directories separated by `:`,[^colon-path] with empty components ignored.[^entry-resolve] An entry that is not a directory fails the launch, naming it.
- **Read like a profile's plugins.** Each directory goes through the same reader: an invalid manifest fails the launch with a message naming the field. Lesser problems are reported while the launch goes on.[^launch-warnings]
- **Matched by name, never by version.** A plugin whose `plugin.json` `name` matches one of the profile's replaces it; on the variable, the last of a name wins.[^no-version]
- **Translated once.** Each harness's translation of a plugin is cached under `${XDG_CACHE_HOME:-~/.cache}/agent-distro/plugins/<key>/<harness>/`.[^cache-dir] An edited checkout is translated again on its next launch.[^cache-key]
- **Kept while in use.** Each launch marks the translations it uses; a launch that translates something new removes what no launch has used for 14 days.[^no-pile-up] With no harness running, removing `~/.cache/agent-distro/plugins` is always safe.
- **For that launch only.** Unset the variable and the harness is back to the profile's plugins.[^undo] Each harness's README says how.

[^colon-path]: So a path containing `:` cannot be given.
[^entry-resolve]: A relative entry is resolved against the directory the launcher starts in, and symlinks are followed. `~` is expanded by the shell, and only where an assignment expands it: unquoted, in bash or zsh, not in fish.
[^launch-warnings]: Skipped skills, a disabled `mcp.json` or an invalid server entry are reported on stderr, on every launch.
[^no-version]: No `version` is compared.
[^cache-dir]: The cache directory must be an absolute path. A launch never calls Nix, and a cache it cannot write fails it.
[^cache-key]: A plugin under `/nix/store` is keyed by its store path, as is, without reading it. Any other directory is keyed by a hash of its contents (its NAR serialization, computed without Nix, leaving out a top-level `.git`) and of its absolute path, so a key is particular to one machine and user. That directory is hashed in full on every launch: a large tree (a `node_modules`, say) costs launch time, and a FIFO or an unreadable file in it fails the launch.
[^no-pile-up]: So old versions of an edited checkout and translations for an older agent-distro do not pile up.
[^undo]: Claude Code and OMP take them as arguments, OpenCode in its session config, and Codex through `-c` overrides; Codex keeps an inert copy in its plugin cache, removed once unused for 14 days. Pi only reads its own files, so it records what a launch added and its next launch, whenever that is, takes it back.

## Install and keep updated {#install}

The Home Manager module puts every harness on your `PATH` and keeps them on the latest build: it checks four times a day,[^update-hours] installs only what the binary cache already holds, and never compiles.

[^update-hours]: At 02:00, 08:00, 14:00 and 20:00 UTC, two hours after upstream's update.

### With Home Manager

```nix
{
  imports = [ inputs.agent-distro.homeManagerModules.default ];
  services.agent-distro = {
    enable = true;
    profile = "vanilla"; # default: juspay
  };
}
```

Home Manager creates the state directory and schedules the updates for you.[^hm-prune]

[^hm-prune]: At activation its prune stage deletes sibling state directories left from an earlier flake/profile choice.

### Without Home Manager

Update by hand:

```sh
nix profile install github:juspay/agent-distro#juspay
nix profile upgrade juspay
```

Or keep the cache-only updates, but drive them yourself:

- **`agent-distro.lib.mkUpdater`** (see [Library](#library)) gives the `command` and a runnable `program`.[^updater-no-compile]
- **`agent-distro.lib.mkShims`** keeps installed commands pointing at the updated bundle.
- **Scheduling is yours.** The updater schedules nothing itself, so run it on your own cadence.[^scheduled-flag]
- **Setup is yours.** Create the `stateDirectory` yourself, and run `--cache-warnings` once to surface an unusable cache.[^no-outlink]

[^updater-no-compile]: Never compiling; it passes nix only `substituters`.
[^scheduled-flag]: It checks the UTC boundary only when you pass `--scheduled`, as the module's launchd does.
[^no-outlink]: The updater replaces `<state>/current` directly, so there is no out-link pruning for the consumer to do.

### Progress output

Append `--progress` to `command` to drive the same update from a program that wants to show the download. Stdout is then one JSON object per line,[^progress-json] and every human message moves to stderr. Exit codes and the history log are the same as without it.

[^progress-json]: `{"progress":{"done":<bytes>,"total":<bytes>}}` while nix fetches, then `{"result":"updated","bundle":"/nix/store/…"}` (or `unchanged`, or `skipped`/`failed` with a `reason`).

### The binary cache

The updater never compiles harnesses from source; it passes the project cache to every update.[^cache-setting] On a multi-user install where you are not a trusted Nix user, add the cache to your NixOS or nix-darwin configuration:[^untrusted]

```nix
nix.settings.extra-substituters = [ "https://cache.nixos.asia/oss" ];
nix.settings.extra-trusted-public-keys = [ "oss:KO872wNJkCDgmGN3xy9dT89WAhvv13EiKncTtHDItVU=" ];
```

> Without it, or when the cache does not yet hold the whole bundle, the update is skipped and your current version keeps working.

`history.log` records the skip,[^skip-line] and activation warns while the cache is unusable.

[^cache-setting]: `cache.nixos.asia/oss`, configurable with `services.agent-distro.substituters`.
[^untrusted]: Nothing more is needed when you are a trusted Nix user or run a single-user install. Otherwise the daemon ignores the updater's request unless your system config already lists the cache.
[^skip-line]: A line such as `skipped: cache https://cache.nixos.asia/oss not usable; add it to nix.settings substituters/trusted-public-keys`. The same line is not repeated, and a skip is not retried until the next scheduled run.

### Troubleshooting

| Symptom | Where to look |
| --- | --- |
| Updates not arriving | `systemctl --user status agent-distro-update`; run manually with `systemctl --user start agent-distro-update` |
| What was updated or failed | `~/.local/state/agent-distro/history.log`[^history-log] |
| Full run output, Linux | `journalctl --user -u agent-distro-update` |
| Full run output, macOS | `~/.local/state/agent-distro/<source>/update.log` |

[^history-log]: Update and failure events, in your local timezone, e.g. `2026-10-01T23:03:17+05:30 juspay updated: Pi 0.99.2 → 1.0.0`; unchanged runs add nothing.

## Build your own distribution

```sh
mkdir my-distribution && cd my-distribution
nix flake init -t github:juspay/agent-distro
```

Point `my-skills` at your Agent Plugins repository and edit `profile.nix`:

| Field | Meaning |
| --- | --- |
| `name` | Distribution identifier; Codex marketplace is `<name>-ai` |
| `description` | Shown with the profile in the picker |
| `plugins` | List of [Agent Plugins](https://agent-plugins.org/specification/) directories[^plugin-dir] |
| `gateway` | `null`, or `{ url; keyEnv; models = { large; small; }; keyHint; }` for a LiteLLM proxy |
| `packages` | Optional `pkgs: [ … ]`: commands the plugins' MCP servers name, put first on `PATH` for every harness[^bare-command] |

[^plugin-dir]: Each is a `plugin.json` manifest, with optional `skills/<name>/SKILL.md` and `mcp.json`.
[^bare-command]: An MCP server that a plugin declares by bare command, such as `"command": "mcp-nixos"`, is found on `PATH`. List its package here and it is built, or fetched from a binary cache, together with the launcher, so the server starts at once instead of being downloaded when the agent first asks for it, and every user runs the version the build pinned.

- **Start from.** The template includes a gateway example; `agent-distro.profiles.vanilla` is the reference profile shape.
- **Pin.** Commit `flake.lock` to pin your build.
- **Run.** Your team runs `nix run github:<you>/my-distribution`.
- **Update.** `nix flake update agent-distro`.

```nix
agent-distro.lib.mkFlake { profile; systems ? [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ]; cache ? …; }
# → packages.<system>: every harness, default picker, and <profile.name> bundle
#   (a bundle's bin/ carries its harness commands and `agent-distro`, its own picker)
#   apps.<system>: every harness and default picker; homeManagerModules.default;
#   lib: the same eight-name library attrset this flake exposes

agent-distro.lib.mkLaunchers { pkgs; profile; }
# → every harness launcher, plus picker and bundle (the bundle's bin/ also holds
#   that picker as `agent-distro`, defaulting to the profile)
```

- **Outputs.** `mkFlake` returns `packages`,[^mkflake-packages] `apps`, `homeManagerModules.default`, and the same `lib` attrset `flake.nix` exposes; add other outputs with `//`.
- **One profile.** A single-profile distribution draws the narrowed list above: one profile's rows under its description. `mkFlake` gives you the individual launchers and a bundle named after the profile, with the picker as its `default`.
- **Cache.** `mkFlake` takes an optional `cache = { url; publicKey; }`, defaulting to agent-distro's cache. Push your own builds to a cache and pass it, or your users' updates are skipped.[^cache-only]

[^mkflake-packages]: Every harness, the default picker, and the `<profile.name>` bundle, which carries its own picker as `bin/agent-distro`.
[^cache-only]: The Home Manager updater only installs what that cache holds and never compiles.

For NixOS, with your distribution bound as `distro`:

```nix
environment.systemPackages = [ distro.packages.${system}.my-profile ];
```

> `AI_GATEWAY=0 nix run .#omp` skips gateway initialization while keeping plugins.[^gateway-off]

[^gateway-off]: It preserves existing settings: choose personal models in OMP or Pi if you previously used gateway defaults. Codex and Claude Code always use their own login.

### Bundle layout

A profile's bundle (`nix build .#<profile.name>`) is self-describing: a consumer reads two files rather than running a command for information.

```text
bin/<harness>…                      # one launcher per harness
bin/agent-distro                    # the picker, defaulting to this profile
share/agent-distro/profile.json     # {"description": "…", "name": "<profile.name>"}
share/agent-distro/versions         # <harness>\t<title>\t<version>, one line per harness, in menu order
```

`profile.json` comes from the same profile attributes as the picker's `--list --json`, so the two cannot drift.[^profile-file]

[^profile-file]: [src/listing.ts](https://github.com/juspay/agent-distro/blob/main/src/listing.ts) types both files (`ProfileFile`, `parseProfileFile`).

### Library

Beyond the launchers, `agent-distro.lib` exposes the pieces Home Manager uses under the hood. Any Nix consumer, not only Home Manager, can keep a profile installed, updated, and chosen.[^plain-import]

[^plain-import]: Every function evaluates from a plain `import` of its `lib/*.nix` file with an arbitrary nixpkgs `pkgs`; a required argument left out is an eval error naming it.

```nix
agent-distro.lib.stateDirectory { xdgStateHome; flake; profile; }
# → the string "<xdgStateHome>/agent-distro/<sha256 of {flake, profile}>", the
#   same hash Home Manager computes today. One function, so a consumer and the
#   updater can never disagree on where `current` lives.

agent-distro.lib.mkShims { pkgs; bundle; stateDirectory; }
# → a derivation whose bin/ holds one shim per bundle.commands, each
#   `exec "<stateDirectory>/current/bin/<name>"` when executable, else
#   `exec <bundle>/bin/<name>`; identical text to the Home Manager module's shims.
#   `bundle` must be a bundle from `mkLaunchers` of this agent-distro (it carries
#   `commands`); anything else is an eval error naming the problem.

agent-distro.lib.mkUpdater { pkgs; bundle; flake; profile; stateDirectory; history; nix; substituters; }
# → { config = <the generated JSON file>; command = [ node update.ts config ];
#   program = <a writeShellApplication running `command "$@"`>; }. The Home
#   Manager module's systemd ExecStart, launchd ProgramArguments (`++ ["--scheduled"]`)
#   and activation `--cache-warnings` all come from this; `command ++ [ "--progress" ]`
#   is the same update with JSON progress on stdout. `bundle` must be a
#   `mkLaunchers` bundle with a `runtime` (post-#59 ones do); the period/offset
#   come from `lib.schedule` and are not overridable here; the updater never
#   compiles, handing nix only `substituters`.

agent-distro.lib.mkPicker { pkgs; profiles; default; }
# → lib/picker.nix's derivation: the interactive profile/harness chooser, where
#   `profiles = { <name> = { profile; launchers; }; … }` — one entry per profile,
#   `launchers` the `mkLaunchers` result for it — and `default` names the preselected one.
```

The updater's schedule is one `lib/schedule.nix`, exposed as `agent-distro.lib.schedule`: `updateHoursUTC`, `defaultFrequency`, `updatePeriodSeconds` and `updateOffsetSeconds`. The module, `mkUpdater` and any consumer read the same numbers.

## Profiles

| Profile | What it is |
| --- | --- |
| `vanilla` | Upstream harnesses with your own provider; no plugins, no gateway |
| `juspay` (default) | Juspay skills + Kolu, via Juspay's LiteLLM gateway |

<details>
<summary>Using the Juspay profile</summary>

```sh
AI_PROFILE=juspay nix run github:juspay/agent-distro
AI_PROFILE=juspay AI_HARNESS=omp nix run github:juspay/agent-distro -- --version
```

- **Adds** Juspay's skills and Kolu.
- **Gateway.** Runs OMP, Pi, and OpenCode against Juspay's LiteLLM gateway, prompting for `LITELLM_API_KEY` unless it is exported.[^litellm-key] `AI_GATEWAY=0` keeps the plugins but skips gateway initialization.
- **Own login.** Codex and Claude Code always use their own login.
- **MCP servers.** Kolu's MCP server needs `kolu` on `PATH`. The profile supplies `mcp-nixos` itself, at its latest release.

[^litellm-key]: Create a key at [grid.ai.juspay.net/dashboard](https://grid.ai.juspay.net/dashboard) (Juspay VPN required).

</details>

A profile is a directory under `profiles/`:

```
profiles/
  registry.nix          # { default = "<name>"; } — the profile the list opens on
  <name>/profile.nix    # { name; description; plugins; gateway; packages; }
  <name>/npins/         # optional: the profile's pinned plugin and package sources
```

- **Discovered.** Profiles are discovered from the directory listing, so adding one is adding a directory; nothing in `flake.nix` names them.
- **Plain data.** `profile.nix` is a plain attrset whose `name` must match its directory.[^packages-fn]
- **Pinned with [npins](https://github.com/andir/npins).** Each profile pins its own sources, not with flake inputs:[^why-npins]

```nix
let sources = import ./npins;
in { name = "example"; plugins = [ sources.skills ]; /* … */ }
```

- **Adding a source.** `npins --directory profiles/<name>/npins add github <owner> <repo>` follows the repository's releases; add `--branch main` to follow a branch.
- **Updates.** The daily update advances every profile's pins alongside the harnesses: a release pin to the latest release, a branch pin to its head.

[^packages-fn]: `packages` is its one function, since only the builder has a package set.
[^why-npins]: The top-level `flake.lock` is inherited by everyone who builds on `lib.mkFlake`, and no distribution's plugins belong there.

## Harnesses

Each harness is a directory under [harnesses/](https://github.com/juspay/agent-distro/tree/main/harnesses); its README holds the design notes for that adapter.

| Harness | Command | Notes |
| --- | --- | --- |
| Oh My Pi | `omp` | [design notes](https://github.com/juspay/agent-distro/blob/main/harnesses/omp/README.md) |
| Codex | `codex` | [design notes](https://github.com/juspay/agent-distro/blob/main/harnesses/codex/README.md) |
| Claude Code | `claude` | [design notes](https://github.com/juspay/agent-distro/blob/main/harnesses/claude/README.md) |
| OpenCode | `opencode` | [design notes](https://github.com/juspay/agent-distro/blob/main/harnesses/opencode/README.md) |
| OpenCode v2 | `opencode2` | [design notes](https://github.com/juspay/agent-distro/blob/main/harnesses/opencode2/README.md) |
| Pi | `pi` | [design notes](https://github.com/juspay/agent-distro/blob/main/harnesses/pi/README.md) |

## How it works

- **Profile.** Harness-independent data.
- **Harness.** The agent application.
- **Plugin.** A portable Agent Plugins directory.
- **Gateway.** An optional LiteLLM proxy used by OMP, Pi, and OpenCode.

Harness design notes live in each directory under [harnesses/](https://github.com/juspay/agent-distro/tree/main/harnesses).

### Runtime

- **TypeScript, no build step.** What runs on your machine beyond the harnesses themselves[^what-runs] is TypeScript under [src/](https://github.com/juspay/agent-distro/tree/main/src), run by Node 24's native type stripping: no `package.json`, bundler or compile step.[^js-entry]
- **Dependencies.** Node comes from the distribution's nixpkgs. Its one npm dependency is `yaml`, for OMP's config.[^yaml-pin]
- **Entry points.** The commands you run, and the shims Home Manager installs, stay small generated shell scripts that call into it.

[^what-runs]: The plugin reader, each harness's config writer, the picker and the Home Manager updater.
[^js-entry]: The one exception is the entry for `AGENT_DISTRO_PLUGINS`, plain JavaScript so that it can turn on Node's compile cache before any TypeScript loads.
[^yaml-pin]: A tarball pinned in `lib/npins`, which [lib/runtime.nix](https://github.com/juspay/agent-distro/blob/main/lib/runtime.nix) links in as `node_modules/yaml`.

### Reading plugins

Every plugin is read once, harness-independently, against Agent Plugins 1.0.0, by the same reader and the same harness writers.[^read-when]

- **Invalid manifest.** Fails the build (or the launch) with a message naming the field.
- **Lesser problems.** Skipped skills, disabled `mcp.json` files and invalid server entries are reported in the build log (or on stderr).[^failure-boundaries]
- **Commands.** A bare MCP `command` is found on `PATH`: the profile's `packages` first, then the user's own. A `./` command runs from the plugin.

> One known gap: Claude Code expands `${VAR}` in a remote server's `url` and `headers`, which the spec forbids.[^var-gap]

[^read-when]: A profile's at build time, and one from `AGENT_DISTRO_PLUGINS` at launch, into the cache described in [Plugins at launch](#plugins-at-launch).
[^failure-boundaries]: As the spec's failure boundaries require.
[^var-gap]: Those values cannot go through a launcher, so a remote server whose URL or headers contain `${` reaches Claude Code as is.

### Shared homes

Profiles share each harness's own home directory, so what OMP and Codex persist outlives the profile that wrote it.[^persisted] Claude Code's plugins last only for the session.

[^persisted]: A Codex marketplace registered by one profile is still registered when you launch `vanilla`, and so are the model roles a gateway filled into OMP's config.

## Development

```sh
nix build .#default    # the picker, and through it every profile's launchers
nix build .#vanilla    # one profile's bundle: its harnesses plus its own bin/agent-distro
nix flake check
just test              # offline NixOS VM tests; Linux with KVM
just test-template
just demo              # re-record doc/demo.gif and the website's stills
python3 .github/scripts/test-update-flake.py
```

The TypeScript's own checks need no VM or KVM, and `nix flake check` at the root does not run them. Build them from the test flake:

```sh
cd test && nix build --no-link .#checks.x86_64-linux.{reader,launch-plugins,omp-adapter,pi-adapter,opencode-adapter,update-schedule,list-json,picker-layout,picker-auth}
```

| Check | Covers |
| --- | --- |
| `reader` | the plugin reader |
| `launch-plugins` | `AGENT_DISTRO_PLUGINS`: cache keys, re-translation, precedence and the launches it fails |
| `<harness>-adapter` | a harness's `tests/check-adapter.ts` |
| `update-schedule` | the updater's schedule and cache policy |
| `list-json` | `--list --json` against its type, the chooser's menu and `--list` |
| `picker-layout` | the chooser's cell widths, truncation and box at common terminal sizes |
| `picker-auth` | the auth probes over fixture homes and stores |

### CI

- **Daily sources.** CI runs `.github/scripts/update-sources.sh`,[^update-sources] then updates the root and test locks.
- **Report.** The update report reads resolved versions and each harness's release-note metadata.
- **Cache.** CI pushes realised paths to the OSS cache.[^attic-token]
- **Merge gate.** The daily update PR merges only after the required Linux/macOS builds and VM/template checks pass.[^auto-merge]
- **Cancellation.** Superseded PR runs are cancelled.
- **Consumers.** They run `nix flake update agent-distro`.

For manual updates, run `bash .github/scripts/update-sources.sh`, `nix flake update`, and then `bash test/update-lock.sh`.

[^update-sources]: It discovers npins directories under `profiles/`, `harnesses/`, and `lib/`, re-pins `yaml` to the newest npm release of its major version, and runs each harness's `update.py`.
[^attic-token]: `ATTIC_TOKEN` is needed except on fork PRs.
[^auto-merge]: The update workflow approves runs GitHub holds back for automation-created pull requests and squash-merges after the checks required by `Require CI on main` pass.

### Test library

Consumers can import `test/lib.nix { pkgs; launchers; profile; features; koluPlugin ? null; }`. Checks are selected by required features from each harness's metadata;[^features] `picker` is shared.

- **Also `mkLaunchers`.** Rebuild and gateway checks also accept `mkLaunchers`.
- **Plugin rebuilds.** Select plugin rebuild checks only for nonempty skill plugins.
- **Coverage.** The test flake covers vanilla (with kolu's plugin loaded at launch), Juspay, and spec fixtures, plus `registry` (the picker over the whole profile registry).

[^features]: The features are `plugins`, `gateway`, `kolu`, `spec`, and `koluLaunch`, which loads `koluPlugin` through `AGENT_DISTRO_PLUGINS`.

### Logo

`doc/logo.svg` is the source vector; downstream consumers (kolu) vendor a copy.

> Keep it transparent, textless, readable at 16 px.

## Adding a harness

Create `harnesses/<name>/` with four files:

| File | Holds |
| --- | --- |
| `meta.nix` | title, order, `auth`,[^auth-values] `releaseNotes = version: URL`, and checks |
| `default.nix` | the adapter, accepting `{ pkgs, plugins, gateway, package, profileName }`[^profile-name] |
| `source.nix` | `{ pkgs }` to package |
| `README.md` | design notes |

[^auth-values]: `auth = "anthropic" | "openai" | "gateway"`.
[^profile-name]: The explicit `profileName` argument supports profile-specific registration, such as Codex’s marketplace name.

- **Alongside.** Pins in `npins/`, scripts in `tests/`, and an optional custom updater in `update.py`.
- **No registration.** Nothing outside this directory needs registration.[^discovery]
- **Logic beyond shell.** Keep it in `src/harness/<name>.ts` and call it with `(import ../../lib/runtime.nix pkgs).script "harness/<name>.ts"`.[^beyond-shell]
- **Unit checks.** Those that need no VM go in `tests/check-adapter.ts`, which receives the runtime's `src` and the harness directory.
- **Checks.** Checks declare `{ name; script; requires ? []; packages ? []; env ? {}; diskSize ? null; }`.[^check-packages] `script` is VM-driver Python.[^guest-script]
- **Gateway checks.** They receive the shared fake service and launchers configured against it.
- **Fixtures.** `mkLaunchers` also accepts a `sources = name: pkgs: …` hook for package fixtures.

[^discovery]: The picker, bundles, outputs, reserved names, checks, and daily report all discover it.
[^beyond-shell]: For an adapter that needs more than shell: translating plugin descriptions into the harness's config, merging user state at launch.
[^check-packages]: Packages can name `updated`, `upstream`, `koluFixture`, or `recordFixture`.
[^guest-script]: Use `import ../../test/guest-script.nix ./tests/check.py` to run a guest script as the unprivileged VM user.
