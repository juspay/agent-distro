---
title: agent-distro
description: "Your team's coding agents, in one command. Package your skills, MCP servers and harness settings once, and run them in every harness."
---

## Quick start

```sh
nix run github:juspay/agent-distro                            # pick from the list
AI_HARNESS=claude nix run github:juspay/agent-distro          # skip the list
nix run github:juspay/agent-distro -- github:juspay/skills    # with a profile from any repository
```

To keep the agents installed and updated, see [Install and keep updated](#install). To give your agents a team's skills, MCP servers and settings, see [Profiles](#profiles).

- **Systems.** `x86_64-linux`, `aarch64-linux`, and `aarch64-darwin`.
- **Binary cache.** Pass `--accept-flake-config` to use the cache this flake names;[^nixconfig] without it, Oh My Pi is built from source.

[^nixconfig]: The cache is named in the flake's `nixConfig`. The Home Manager updater in [Install](#install) handles the cache itself.

### The chooser

The chooser is master–detail: harnesses are the list on the left, and the highlighted harness fills the panel on the right.[^chooser-rows] The [profiles](#profiles) in effect for the launch are in the header — named from the bottom of the stack up, `juspay + repo` — and the row under it says what the top one is and where every one of them came from. Nothing in the box is ever cut.

Here the terminal is in a repository whose `agent-distro.nix` is the Juspay profile, and `pi` is remembered from last time.

[^chooser-rows]: The panel shows the highlighted harness's tagline and its auth status. Versions reflect the packages pinned at build time, shown without revision suffixes.

```
╭─ agent-distro · juspay ────────────────────────────────────── 5 harnesses ─╮
│ juspay · Juspay skills + Kolu, via Juspay's LiteLLM gateway · from         │
│ /home/me/src/skills/agent-distro.nix                                       │
├──────────────────────────────┬─────────────────────────────────────────────┤
│     ✓ Oh My Pi       18.7.0  │ Pi 1.0.4                                    │
│     ✓ Codex         0.160.1  │ OMP's upstream · plugins per home           │
│     ✓ Claude Code   2.1.292  │                                             │
│     ✓ OpenCode       2.0.29  │ Signed in                                   │
│ ❯ • ✓ Pi              1.0.4  │   LITELLM_API_KEY                           │
├──────────────────────────────┴─────────────────────────────────────────────┤
│ / filter…                                                                  │
╰────────────────────────────────────────────────────────────────────────────╯
↑↓ jk move   Enter launch   / filter   q quit
```

| Variable[^var-names] | Values | Effect |
| --- | --- | --- |
| `AI_HARNESS` | a directory under `harnesses/` | Launches that harness without the list[^non-interactive] |
| `AI_PROFILE` | whitespace-separated profile [references](#profiles) | Your profiles, under the repository's own[^profile-fallback] |
| `AGENT_DISTRO_SETTINGS` | `0` | Keeps the plugins; leaves out the profile's `env` and `settings` |
| `AGENT_DISTRO_PLUGINS` | `:`-separated plugin directories | Loads more plugins for that launch; see [Plugins at launch](#plugins-at-launch) |
| `AGENT_DISTRO_LOG` | `silent`, `error`, `warn`, `info` (default), `debug`, `trace` | How much agent-distro says on stderr; see [Diagnostics](#diagnostics) |

[^var-names]: Names unchanged for script compatibility.
[^non-interactive]: Also usable in scripts and non-interactive shells.
[^profile-fallback]: Read by every command, `agent-distro`, `claude`, `omp` and the rest alike: it is the profiles an environment such as Kolu sets. Whitespace-separated, composed left to right, later entries winning — as nix's own lists are (`substituters`). See [Profiles](#profiles) for how that composes.

### By name

| Command | Does |
| --- | --- |
| `agent-distro <harness>` | Launches directly |
| `agent-distro <profile> <harness>` | Launches with that profile |
| `agent-distro <profile>` | Opens the chooser with that profile |

A leading argument naming a harness is the harness. Otherwise any value containing `/` or `:` is a profile: a path, which when relative must start with `./`, or a flake reference. A profile built by `agent-distro.lib.mkProfile` is an absolute path, and works the same way.

```sh
agent-distro codex --version
agent-distro github:juspay/skills claude --version
agent-distro ./path/to/repo claude
agent-distro /nix/store/…-agent-distro-profile-juspay omp   # a built profile, by its store path
agent-distro --list                      # the profiles in effect, then harness title version, one per line
agent-distro --list --json               # the same, as JSON (below)
```

- **Precedence.** The positional profile is used exactly, alone. Otherwise the repository's `agent-distro.nix` is composed over the profiles of `AI_PROFILE` ([Profiles](#profiles)). `AI_HARNESS` takes precedence over a positional harness.
- **Passthrough.** Recognized leading selectors are consumed;[^dash] other arguments and everything after `--` are passed to the harness unchanged.

[^dash]: An argument starting with `-` is never a selector, so `agent-distro --model=a:b` passes it to the harness.

### Signed-in marks

`✓` marks a harness that can start without a login step; the panel beside it says what was found.[^presence] A harness with nothing to start from shows a dim `Not signed in` and no mark.[^unreadable]

| Harness | Looks at |
| --- | --- |
| Claude Code | `oauthAccount.emailAddress` in `$CLAUDE_CONFIG_DIR/.claude.json`,[^claude-default] or the name of `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` |
| Codex | the `email` claim of the OpenID token in `$CODEX_HOME/auth.json`,[^codex-claim] or `OPENAI_API_KEY` |
| OMP, OpenCode, Pi | the profile's `secret` variables, then the provider ids it also has credentials for[^both] |
| Own-provider harnesses | the ids in the harness's store,[^stores] plus the provider API-key variables it reads from the environment |

A `secret` variable the profile declares and the environment does not set is a login step still to come, so its row is not signed in. `AGENT_DISTRO_SETTINGS=0` puts those harnesses back on their own providers. This is a launch-time fact: `--list` and `--list --json` never carry it.

[^presence]: Presence only: the picker contacts no provider and checks no token's validity or expiry.
[^unreadable]: One whose store cannot be read shows nothing at all, and no mark.
[^claude-default]: Default `~/.claude.json`.
[^codex-claim]: Read from `tokens.id_token` without checking its signature; `ChatGPT` when the claim is absent.
[^both]: The profile's secrets and the harness's own providers are usable at once.
[^stores]: OMP's `~/.omp/agent/agent.db`, Pi's `$PI_CODING_AGENT_DIR/auth.json` (default `~/.pi/agent/auth.json`), OpenCode's `${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json`.

### Keys

| Key | Does |
| --- | --- |
| <kbd>↑</kbd>/<kbd>↓</kbd>, <kbd>j</kbd>/<kbd>k</kbd> | Move in the list |
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

An interactive selection is remembered in `${XDG_STATE_HOME:-$HOME/.local/state}/agent-distro/last-choice`.[^state-unavailable] Next time the cursor starts on that harness, which is marked with `•`.

- **Updates it.** Every interactive choice, including `agent-distro <profile>`.
- **Never updates it.** Direct selections: `AI_HARNESS`, `agent-distro <harness>`, or `agent-distro <profile> <harness>`.

[^state-unavailable]: An unavailable state directory is silently ignored.

### Listing as JSON

`agent-distro --list --json` prints what the chooser draws, on one line, for programs that offer the same choice (such as [kolu](https://github.com/juspay/kolu)).[^listing-type] Here it is pretty-printed, cut to one harness, from a terminal in a repository with its own profile, with `AI_PROFILE=github:juspay/skills`:

[^listing-type]: Its shape is stable, typed as `Listing` in [src/listing.ts](https://github.com/juspay/agent-distro/blob/main/src/listing.ts).

```json
{
  "harnesses": [
    {
      "name": "claude",
      "tagline": "Anthropic login · plugin dirs per session",
      "title": "Claude Code",
      "version": "2.1.291"
    }
  ],
  "profile": {
    "name": "ekala",
    "description": "Ekala's Nix development skills",
    "source": "repository",
    "origin": "/home/me/src/ekala-ai-skills/agent-distro.nix",
    "over": {
      "name": "juspay",
      "description": "Juspay skills + Kolu, via Juspay's LiteLLM gateway",
      "source": "variable",
      "origin": "github:juspay/skills"
    }
  }
}
```

| Field | Rule |
| --- | --- |
| `harnesses` | The harnesses this package ships, in menu order |
| `name` | Free of whitespace and `/`; what `AI_HARNESS` (or a positional selector) takes |
| `version` | The display version, as `--list` prints it[^plus-suffix] |
| `profile` | The profile in effect for a launch from the same directory and environment; absent when there is none |
| `profile.source` | `positional`, `repository` or `variable` (`AI_PROFILE`) |
| `profile.origin` | The reference as given, or the path to the `agent-distro.nix` found |
| `profile.over` | The profile composed beneath it, in the same shape: a repository's over your `AI_PROFILE`, each entry over the one before |

Keys within `harnesses` are sorted; `profile`'s are in the order above. `--list` takes no other arguments.[^three-agree] A profile that cannot be read fails `--list` as it would fail a launch.

[^plus-suffix]: Without the package's `+` revision suffix.
[^three-agree]: The plain `--list` and the chooser read the same value, so the three cannot disagree.

### Plugins at launch

A profile fixes the plugins its harnesses start with. Put more [Agent
Plugins](https://agent-plugins.org) directories on `AGENT_DISTRO_PLUGINS`, and
every harness loads them too, on top of whichever profile is in effect, for
that launch:

```sh
AGENT_DISTRO_PLUGINS=~/src/my-plugin agent-distro claude
AGENT_DISTRO_PLUGINS=/nix/store/…-kolu/agent-plugin:~/src/my-plugin agent-distro github:juspay/skills omp
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
[^cache-dir]: The cache directory must be an absolute path. Loading these plugins never calls Nix, and a cache it cannot write fails the launch.
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
    profiles = [ "github:juspay/skills" ];   # default: none
  };
}
```

Home Manager creates the state directory and schedules the updates for you.[^hm-prune] One package is installed — the picker and every harness command ([Package layout](#package-layout)) — and `profiles` is what every command it installs exports as `AI_PROFILE`, whitespace-separated: a [reference](#profiles), read when a harness starts, or anything else — a path, or a flake input — which is built by `agent-distro.lib.mkProfile` and read from the store, pinned and offline.[^hm-reference]

```nix
inputs.skills = { url = "github:juspay/skills"; flake = false; };

services.agent-distro.profiles = [ inputs.skills "github:ekala-project/ekala-ai-skills" ];
```

[^hm-reference]: An `AI_PROFILE` already in the environment wins, and a repository's own `agent-distro.nix` is composed over either. Every entry is a profile reference or something built from one; a string that is neither stops the launch, naming it. `profile`, the one-profile spelling of this option, is deprecated for one release: a reference becomes `profiles = [ it ]`.

[^hm-prune]: At activation its prune stage deletes sibling state directories left from an earlier flake/profile choice.

### Without Home Manager

Update by hand:

```sh
nix profile install github:juspay/agent-distro#default
nix profile upgrade default
```

Or keep the cache-only updates, but drive them yourself:

- **`agent-distro.lib.mkUpdater`** (see [Library](#library)) gives the `command` and a runnable `program`.[^updater-no-compile]
- **`agent-distro.lib.mkShims`** keeps installed commands pointing at the updated package.
- **Scheduling is yours.** The updater schedules nothing itself, so run it on your own cadence.[^scheduled-flag]
- **Setup is yours.** Create the `stateDirectory` yourself, and run `--cache-warnings` once to surface an unusable cache.[^no-outlink]

[^updater-no-compile]: Never compiling: it hands nix `substituters`, and where this user's nix will not honour them, the revision's published content-addressed path instead.
[^scheduled-flag]: It checks the UTC boundary only when you pass `--scheduled`, as the module's launchd does.
[^no-outlink]: The updater replaces `<state>/current` directly, so there is no out-link pruning for the consumer to do.

### Progress output

Append `--progress` to `command` to drive the same update from a program that wants to show the download. Stdout is then one JSON object per line,[^progress-json] and every human message moves to stderr. Exit codes and the history log are the same as without it.

[^progress-json]: `{"progress":{"done":<bytes>,"total":<bytes>}}` while nix fetches, then one result object: `{"result":"updated"|"unchanged","package":"<store path>"}`, or `skipped`/`failed` with a `reason` (a `failed` result also carries `detail`, nix's last `error:` line, when there is one).

### The binary cache {#binary-cache}

The updater never compiles harnesses from source; it passes the project cache to every update.[^cache-setting] A trusted user, or a single-user install, is done there. A Nix daemon lets nobody else's request through, though: for a user the daemon does not trust, nix drops the updater's substituter, its key *and* `--no-check-sigs`. So there are two ways to feed such a user, and the updater takes the second when the first is out of reach.

**Signed paths, if you list the cache.** Add the cache to your NixOS or nix-darwin configuration:[^untrusted]

```nix
nix.settings.extra-substituters = [ "https://cache.nixos.asia/oss" ];
nix.settings.extra-trusted-public-keys = [ "oss:KO872wNJkCDgmGN3xy9dT89WAhvv13EiKncTtHDItVU=" ];
```

**Content-addressed paths, without touching `nix.conf`.** A *content-addressed* store path is trusted by itself: nix copies one from any cache, for any user, without a signature (`require-sigs`, `nix store make-content-addressed`). CI therefore rewrites the package it built that way for each revision, through the publisher this distribution shares with kolu ([`.github/actions/publish-closure`](https://github.com/juspay/kolu/tree/main/.github/actions/publish-closure), [juspay/kolu#2294](https://github.com/juspay/kolu/pull/2294)), and publishes an index of what it wrote:

```
https://raw.githubusercontent.com/juspay/agent-distro/ca-index/<rev>/<system>/default.json
# {"rev": "0f3c…", "ia": "/nix/store/…-agent-distro", "ca": "/nix/store/…-agent-distro"}   ← Linux
# {"rev": "0f3c…", "ia": "/nix/store/…-agent-distro"}                                      ← macOS
https://raw.githubusercontent.com/juspay/agent-distro/ca-index/latest/<system>/default.json
# {"rev": "0f3c…", "ia": "/nix/store/…-agent-distro", "ca": "/nix/store/…-agent-distro"}
```

The publisher names each entry after the flake attribute it built, so the one package — `packages.<system>.default` — is `default.json`.[^old-key]

`<rev>` is the revision CI built, which is what an updater looks its own entry up by; `latest/` names the newest build a system published, with the revision that wrote it so a consumer can tell whether what it has is what this names. Only a push to `main` writes `latest/`, so a pull request's build never moves it, and each system moves only its own file.

This index is agent-distro's. A consumer that publishes its own builds names its own index with `caIndex` (`services.agent-distro.caIndex`, or `mkUpdater`'s `caIndex`) — an `https://` base URL with no credentials, query or fragment, the only kind the updater will fetch from; anything else is ignored with a warning, and the update skips. Its revisions are not in this index, and an entry that is not there leaves the update skipped too.[^ca-index]

`ia` is the package as built — what the cache holds signed, for users that can use it — and `ca` its content-addressed rewrite, which needs no signature. The updater reads the pair for the revision it is on and the system it runs, copies `ca` from the configured cache, and points `current` at it: no build, no `--option`, no configuration on your side. Before the index names a path, CI pushes the rewritten closure and reads one back from the cache into a throwaway store, verifying its contents — a rewrite that a consumer's nix cannot verify never reaches the index. Which nix does the rewriting matters for that: 2.35 hashes a self-referential NAR differently than 2.17–2.34 do, so CI rewrites with the release the fleet runs (kolu's `publish-closure` action installs 2.34.8 itself, so it is the job's only Nix), not the newest. **These paths target Nix 2.34.x, and nothing else.** Measured both ways on a closure that has such a path (libunistring's `.la` files): a 2.34 rewrite fails to import on 2.35 and a 2.35 rewrite fails on 2.34, each with `ca hash mismatch` naming the same two digests — the lines do not accept each other's form. A host on 2.35 or later therefore cannot take these paths and takes the ordinary skip; the signed path and the cache key above are its route, and so is a single-user install of either line. Anyone can do the same by hand, with the `ca` path the index names:

```sh
nix copy --from https://cache.nixos.asia/oss /nix/store/…-agent-distro
```

> A revision CI has not built yet, a `path:` flake (which names no revision to key an entry by), and a cache that does not hold the path all end the same way: the update is skipped and your current version keeps working.

**Content-addressed paths are Linux-only; macOS keeps signed ones.** The rewrite edits every file in the closure that embeds a store path, and a Mach-O is one of them: the edit invalidates the binary's ad-hoc signature, and arm64 macOS then kills it on exec. Nothing can repair that afterwards — re-signing would change the bytes again — so a `*-darwin` entry names the signed path alone — and the updater on such a system fetches nothing content-addressed even where an older entry still names one — and a Mac needs the cache key (above) or a trusted user, exactly as before this index existed. A Mac whose cache is unusable skips, saying so, and keeps the version it has.

`history.log` records the skip,[^skip-line] and activation warns while the cache is unusable.

[^cache-setting]: `cache.nixos.asia/oss`, configurable with `services.agent-distro.substituters`.
[^ca-index]: Where the index lives is stated once, in [lib/ca-index.nix](https://github.com/juspay/agent-distro/blob/main/lib/ca-index.nix): `mkUpdater` reads it, [`binary-cache.json`](https://github.com/juspay/agent-distro/blob/main/binary-cache.json) — the declaration `cache.yml` hands the publisher — carries it and the cache, and `.github/scripts/check-cache-config.py` keeps that file and this page equal to both.
[^untrusted]: Nothing more is needed when you are a trusted Nix user or run a single-user install. Otherwise the daemon ignores the updater's request unless your system config already lists the cache.
[^skip-line]: A line such as `skipped: cache https://cache.nixos.asia/oss not usable and no content-addressed path is published for revision 0f3c…; add it to nix.settings substituters/trusted-public-keys`. The same line is not repeated, and a skip is not retried until the next scheduled run.
[^old-key]: Transition only: CI also writes `<rev>/<system>/vanilla.json` and `latest/<system>/vanilla.json`, the same content under a `vanilla` attribute that aliases the one package, so updaters still reading the old profile-keyed name keep working. Both, and `packages.<system>.vanilla`, go away on **2026-11-14**, thirty days after the one-package release: the PR that removes them also drops the alias from `cache.yml` and from `flake.nix`.

### Troubleshooting

| Symptom | Where to look |
| --- | --- |
| Updates not arriving | `systemctl --user status agent-distro-update`; run manually with `systemctl --user start agent-distro-update` |
| What was updated or failed | `~/.local/state/agent-distro/history.log`[^history-log] |
| Full run output, Linux | `journalctl --user -u agent-distro-update` |
| Full run output, macOS | `~/.local/state/agent-distro/<source>/update.log` |

[^history-log]: Update and failure events, in your local timezone, e.g. `2026-10-01T23:03:17+05:30 updated: Pi 0.99.2 → 1.0.0`; unchanged runs add nothing. It is trimmed back to its last 1000 lines once it has grown past them, and a scheduled run on macOS cuts `update.log` to its last 1 MB.

### Diagnostics

Every message agent-distro prints goes to stderr as `agent-distro <component>: …`, with `warning:` or `error:` when it is one. Stdout is never used for messages: launchers and tools read it.

By default a launch prints a line only when something chose a profile for you, a repository's `agent-distro.nix` or `AI_PROFILE`, worded as `--list` words it:

```text
agent-distro profile: using repo (from /home/me/repo/agent-distro.nix) · https://agent-distro.nixos.asia
agent-distro profile: using juspay + repo (from /home/me/repo/agent-distro.nix over AI_PROFILE=github:juspay/skills) · https://agent-distro.nixos.asia
```

and when something will take a while, such as evaluating a profile for the first time or fetching its packages. A launch with no profile, or with one you named yourself, prints nothing.

To see the nix commands run, the cache hits and misses, each plugin and where it came from, the PATH additions, the environment and settings, and the arguments handed to the harness:

```sh
AGENT_DISTRO_LOG=debug claude
```

`AGENT_DISTRO_LOG` sets the level of agent-distro's own messages, so `AGENT_DISTRO_LOG=silent` leaves only the harness's output and the few warnings the launcher scripts themselves print (a missing secret variable, a replaced harness configuration file, a `PATH` collision), which are always shown. Colors follow `NO_COLOR` and `FORCE_COLOR`. Updater output is in the journal or `update.log`; see [Troubleshooting](#troubleshooting), and `journalctl --user -u agent-distro-update -p warning` for its warnings and errors alone.

## Package layout

`agent-distro.packages.<system>.default` (`nix build .#default`) is the whole distribution, and self-describing: a consumer reads a file rather than running a command for information.

```text
bin/<harness>…                      # one launcher per harness
bin/agent-distro                    # the picker, the package's main program
share/agent-distro/versions         # <harness>\t<title>\t<version>, one line per harness, in menu order
```

`versions` lists the harness packages this build pinned, the same values `--list` prints, so the two cannot drift. A [profile](#profiles) needs no package of its own: any agent-distro reads one at launch.

## Library

Beyond the launchers, `agent-distro.lib` exposes the pieces Home Manager uses under the hood. Any Nix consumer, not only Home Manager, can keep the package installed, updated, and launched with a profile.[^plain-import]

[^plain-import]: Every function evaluates from a plain `import` of its `lib/*.nix` file with an arbitrary nixpkgs `pkgs`; a required argument left out is an eval error naming it.

```nix
agent-distro.lib.mkLaunchers { pkgs; sources ? …; nixpkgs ? null; }
# → every harness launcher, plus `picker` and `package`, the package of
#   [Package layout](#package-layout). `nixpkgs`, the flake input `pkgs` came
#   from, names that nixpkgs by a locked reference, fetched only for a profile
#   with `packages`; any other `pkgs` puts its source in the closure. `sources
#   = name: pkgs: …` substitutes a harness's own package, for fixtures.

agent-distro.lib.mkPicker { pkgs; launchers; nixpkgs ? null; }
# → lib/picker.nix's derivation: the interactive harness chooser over
#   `launchers`, a `mkLaunchers` result.

agent-distro.lib.mkProfile { system; profile; }
# → one profile, built: an `agent-distro.nix` — a path to the file, to the
#   directory holding one, a flake input (whose `outPath` is a store path), or
#   the attribute set it holds — with its plugins read and its `packages`
#   realised. Its store path is an `AI_PROFILE` value ([Profiles](#profiles)),
#   used as it is. A plugin named by a flake reference is locked as the
#   profile is built — fetched once, and built in as that store path — which
#   needs an impure evaluation (`nix build --impure`); a pure one refuses it,
#   so there pin it as a flake input and pass that path.
#   `hostSystem` (default `system`) is the system a profile built here is
#   shipped to and launched on: when it differs, the profile is built for
#   `system` without packages — plugins, `env` and `settings` mean the same on
#   any system — and one with `packages` for `hostSystem` is refused, naming
#   it and both systems, since `system` cannot build them.

agent-distro.lib.stateDirectory { xdgStateHome; flake; profile; }
# → the string "<xdgStateHome>/agent-distro/<sha256 of {flake, profile}>", with
#   `profile` what the updater builds (the module passes the package's
#   attribute, `default`), not an AI_PROFILE: a profile's own store path
#   changes whenever its input does, and hashing it would churn what holds
#   `current` on every `nix flake update`. An install that predates the
#   one-package release hashed the old `vanilla` name, so its first activation
#   after the upgrade starts a new state directory and the prune hook removes
#   the old one. One function, so a consumer and the updater can never
#   disagree on where `current` lives.

agent-distro.lib.historyFile xdgStateHome
# → "<xdgStateHome>/agent-distro/history.log": the one history log the Home
#   Manager module's updater appends to, and any consumer recording its own
#   installs in it — appended through `./update/history-log` (below), which
#   keeps it trimmed.

agent-distro.lib.mkShims { pkgs; package; stateDirectory; profile ? null; }
# → a derivation whose bin/ holds one shim per package.commands, each
#   `exec "<stateDirectory>/current/bin/<name>"` when executable, else
#   `exec <package>/bin/<name>`; identical text to the Home Manager module's
#   shims. `package` must be a `mkLaunchers` package of this agent-distro (it
#   carries `commands`); anything else is an eval error naming the problem. A
#   `profile` is exported as AI_PROFILE unless the environment sets one.

agent-distro.lib.mkUpdater { pkgs; package; flake; attribute ? "default"; stateDirectory; history; nix; substituters; caIndex ? …; }
# → { config = <the generated JSON file>; command = [ node update.ts config ];
#   program = <a writeShellApplication running `command "$@"`>; }. The Home
#   Manager module's systemd ExecStart, launchd ProgramArguments (`++ ["--scheduled"]`)
#   and activation `--cache-warnings` all come from this; `command ++ [ "--progress" ]`
#   is the same update with JSON progress on stdout. Each run builds
#   `<flake>#<attribute>` and reads that attribute's index entry; `package`
#   must be a `mkLaunchers` package with a `runtime` (post-#59 ones have one).
#   The period/offset come from `lib.schedule` and are not overridable here;
#   the updater never compiles: it hands nix `substituters`, and for a user
#   whose nix will not honour them it copies the revision's published
#   content-addressed path from one of them instead
#   ([The binary cache](#binary-cache)).
```

`agent-distro.lib.cache` is the project's binary cache (`{ url; publicKey; }`) and `agent-distro.lib.caIndex` where its content-addressed paths are indexed; a consumer that pushes its own builds passes its own to `mkUpdater`, or its users' updates are skipped.[^cache-only]

[^cache-only]: The Home Manager updater only installs what that cache holds, or the content-addressed path your index names, and never compiles.

The updater's schedule is one `lib/schedule.nix`, exposed as `agent-distro.lib.schedule`: `updateHoursUTC`, `defaultFrequency`, `updatePeriodSeconds` and `updateOffsetSeconds`. The module, `mkUpdater` and any consumer read the same numbers.

The updater's words are a small TypeScript library a program can import rather than repeat: `src/package.json` names it `@juspay/agent-distro`, with no dependencies. `./update/due` is the due rule (`updateDue`), the scheduled run's `SCHEDULED_ATTEMPTS` and `SCHEDULED_RETRY_SECONDS`, and the `last-success` reader (`parseStamp`); `./update/state` names a state directory's `current` link and `last-success` stamp (`currentLink`, `lastSuccessFile`); `./update/history` writes and reads a history line (`historyLine`, `parseHistoryLine`, `parseHistory`); `./update/history-log` is the log's one writer, `appendHistory`, which keeps its newest `HISTORY_LINES` under a lock every writer shares — the one module here that touches files; `./update/versions` reads a package's `share/agent-distro/versions` (`parseVersions`) and words what changed between two (`changes`); `./profile/reference` says what a profile reference names (`classifyReference`: a path, a flake reference, or nothing), the `nix` arguments that fetch a flake reference (`prefetchArgs`) and where its answer put it (`prefetchedTree`) — the launch's own rules, so a program that builds profiles ahead of a launch runs the fetch itself and reads it the same way; `./listing` is the `--list --json` value and its checker (`parseListing`). kolu, which builds profiles and delivers the package to hosts of its own and appends to the same history log, imports them from its pin of this repository.

## Profiles

A profile is an `agent-distro.nix` in a git repository:

```nix
{
  name = "ekala";
  description = "Ekala's Nix development skills";
  plugins = [ ./. ];              # Agent Plugins directories: a path relative to this file,
                                  # or a flake reference string such as "github:juspay/kolu?dir=agent-plugin"
  env = {                         # optional: exported before the harness starts
    LITELLM_BASE_URL = "https://llm.ekala.example";
    LITELLM_API_KEY = { secret = true; hint = "Ask the platform team"; };  # asked for when unset
  };
  settings = {                    # optional: what the harnesses that read it default
    omp.modelRoles = { default = "litellm/large"; slow = "litellm/large";
                       task = "litellm/large"; smol = "litellm/fast"; };
    opencode = {
      providers.litellm = { package = "@opencode/ai/providers/openai-compatible";
                            settings.baseURL = "https://llm.ekala.example/v1"; };
      model = "litellm/large";
      agents.title.model = "litellm/fast";
    };
  };
  packages = pkgs: [ ];           # optional: commands the plugins' MCP servers name
}
```

| Field | Meaning |
| --- | --- |
| `name` | Profile identifier; the chooser and `--list` name the stack with it |
| `description` | Shown with the profile in the picker |
| `plugins` | List of [Agent Plugins](https://agent-plugins.org/specification/) directories[^plugin-dir] |
| `env` | Optional: variables every launch exports, and `{ secret = true; hint ? };` ones it prompts for when unset |
| `settings` | Optional: what `omp` and `opencode` default, in their own configuration's shape |
| `packages` | Optional `pkgs: [ … ]`: commands the plugins' MCP servers name, put first on `PATH` for every harness[^bare-command] |

[^plugin-dir]: Each is a `plugin.json` manifest, with optional `skills/<name>/SKILL.md` and `mcp.json`. A path is taken relative to the `agent-distro.nix`; a flake reference string is read at launch, or locked once when `mkProfile` builds the profile (impurely; see [Library](#library)).
[^bare-command]: An MCP server that a plugin declares by bare command, such as `"command": "mcp-nixos"`, is found on `PATH`. List its package here and it is built, or fetched from a binary cache, so the server starts at once instead of being downloaded when the agent first asks for it, and every user runs the version the profile pinned.

### Run with a profile

```sh
nix run github:juspay/agent-distro                          # no profile: upstream harnesses, nothing added
nix run github:juspay/agent-distro -- github:juspay/skills  # one profile
AI_PROFILE=github:juspay/skills agent-distro omp            # the same, by variable
```

A repository's own `agent-distro.nix` is composed on top of that whenever a harness starts inside
one: with no profile named on the command line, the launcher composes the `agent-distro.nix` found
from the working directory up to the git root over every `AI_PROFILE` entry.
Discovery needs a git repository: an `agent-distro.nix` in a plain directory is read only when
named, as `./dir` or in `AI_PROFILE`. A terminal opened in a repository, in Kolu or anywhere,
starts its agents with that repository's profile on top of yours.

### Run with several

`AI_PROFILE` is a stack, whitespace-separated — as nix's own lists are — composed left to
right: later entries win where they overlap, plugins and packages accumulate. No reference or
store path holds whitespace, so a flake reference keeps the `:` in it.

```sh
AI_PROFILE="github:juspay/skills github:ekala-project/ekala-ai-skills" agent-distro omp
```

So in `~/code/kolu`, with the variable above, OMP starts with Juspay's skills, Ekala's skills, and
Kolu's own — and Juspay's gateway, because nothing above it set another one. The picker header
names the stack: `juspay + ekala + kolu`.

| Field | Composed, from the bottom up |
| --- | --- |
| `plugins`, `packages` | All of them, the bottom first; a plugin replaces one of the same name beneath it |
| `env`, `settings` | Key by key, the topmost winning; the same harness a second time replaces that harness's whole section |
| `name`, `description` | The topmost; the chooser and `--list` name the whole stack, as `juspay + ekala + kolu` |

A profile named on the command line is that profile alone: nothing is composed beneath it, not even
a repository's own.

### Pin a profile (optional)

A profile repository pins nothing and has no flake. If *you* want a profile pinned, cached and
offline, pin it where you already pin things — your Home Manager or NixOS flake. A flake input is a
store path, and a store path on `profiles` is built as a derivation:

```nix
# your configuration flake
inputs.skills = { url = "github:juspay/skills"; flake = false; };

services.agent-distro.profiles = [ inputs.skills ];   # built: plugins read, packages realised
```

Outside Home Manager, `agent-distro.lib.mkProfile { system; profile = inputs.skills; }` is the same
derivation; its store path works anywhere a reference does:

```sh
AI_PROFILE=/nix/store/…-agent-distro-profile-juspay agent-distro omp   # built
AI_PROFILE=github:juspay/skills agent-distro omp                      # the same profile, read at launch
```

Both work offline after first use; the built one also never touches the network for its plugins, and
never compiles. juspay/skills itself stays a repository with an `agent-distro.nix`.

### Opt out, per launch

```sh
AGENT_DISTRO_SETTINGS=0 agent-distro omp     # plugins only: no env, no secrets prompt, no settings
AI_PROFILE= agent-distro omp                 # nothing but the repository's own profile, if any
```

- **Nothing to register.** Any repository with an `agent-distro.nix` is a profile.
- **Always the latest agent-distro.** The profile is read when the harness starts, by whatever
  agent-distro you run. The repository pins nothing.
- **Read once.** Each profile and its `packages` are evaluated on first use and cached per file,
  content and agent-distro build, like plugin translations.[^profile-cache]
- **Never compiles.** `packages` come from the binary cache or the launch stops and names the
  missing one.[^never-compiles]
- **Works offline.** A flake reference that cannot be fetched uses the store path it last
  resolved to, and says so on stderr.[^profile-cache]
- **Trust.** Reading a profile is safe: Nix evaluates it restricted, without network, without your
  environment, and reading nothing outside its directory and nixpkgs. Using one is not: its plugins
  and MCP servers run, and its `env` and `settings` reach your agents — including a `secret`
  variable, which the launcher asks for and never writes to a file. Only open terminals in repositories you trust, as you already do with
  their `.envrc`.

[^profile-cache]: Under `${XDG_CACHE_HOME:-~/.cache}/agent-distro/profiles/`, one entry per file, so a repository's profile over two `AI_PROFILE` entries is three, each evaluated again only when its own file changes; removed once unused for 14 days. A flake reference, the profile's or a plugin's, is fetched with `nix flake prefetch` on every launch, so an unpinned one follows its branch; Nix's tarball TTL bounds what that costs. Its last store path is kept under `agent-distro/references/` for launches without network. `packages` are evaluated against the nixpkgs agent-distro itself was built with, so they hit the same binary cache; launchers name that nixpkgs by a locked reference and fetch its source only for a profile with `packages`. A built profile is read rather than evaluated: its metadata, its plugins and their descriptions are all in the store.
[^never-compiles]: Under the same policy as the updater: what a build would compile rather than fetch stops the launch.

| Profile | What it is |
| --- | --- |
| `github:juspay/skills` | Juspay skills + Kolu, via Juspay's LiteLLM gateway |
| `/nix/store/…-agent-distro-profile-…` | Any profile built with `agent-distro.lib.mkProfile` (`profiles = [ inputs.skills ]`): pinned, offline, and unevaluated at launch |

<details>
<summary>Using the Juspay profile</summary>

```sh
nix run github:juspay/agent-distro -- github:juspay/skills
nix run github:juspay/agent-distro -- github:juspay/skills omp --version
AI_PROFILE=github:juspay/skills agent-distro claude
```

Its `agent-distro.nix` is the whole of it:[^litellm-key]

```nix
{
  name = "juspay";
  description = "Juspay skills + Kolu, via Juspay's LiteLLM gateway";
  plugins = [ ./. "github:juspay/kolu?dir=agent-plugin" ];
  packages = pkgs: pkgs.lib.optionals (pkgs.stdenv.hostPlatform.system == "x86_64-linux") [ pkgs.mcp-nixos ];
  env = {
    LITELLM_BASE_URL = "https://grid.ai.juspay.net";
    OMP_SKIP_SETUP = "1";
    LITELLM_API_KEY = { secret = true; hint = "Create a key at grid.ai.juspay.net/dashboard (Juspay VPN)"; };
  };
  settings = {
    omp.modelRoles = { default = "litellm/open-large"; slow = "litellm/open-large";
                       task = "litellm/open-large"; smol = "litellm/open-fast"; };
    opencode = {
      providers.litellm = { package = "@opencode/ai/providers/openai-compatible";
                            settings.baseURL = "https://grid.ai.juspay.net/v1"; };
      model = "litellm/open-large";
      agents.title.model = "litellm/open-fast";
    };
  };
}
```

- **Adds** Juspay's skills and Kolu, and points OMP and OpenCode at Juspay's LiteLLM gateway. It asks for `LITELLM_API_KEY` when it is not already set, and never writes it to a file.
- **Settings.** OMP starts on the gateway's models, and OpenCode finds them through the plugin its session config already loads; neither replaces a model you chose yourself.
- **Own login.** Pi, Claude Code and Codex use their own login: they get the profile's variables, not its model settings.
- **MCP servers.** Kolu's MCP server needs `kolu` on `PATH`. The profile supplies `mcp-nixos` itself, from nixpkgs.
- **Opt out.** `AGENT_DISTRO_SETTINGS=0` keeps the plugins and skips the rest.

[^litellm-key]: Create a key at [grid.ai.juspay.net/dashboard](https://grid.ai.juspay.net/dashboard) (Juspay VPN required).

</details>

### Checking a profile's packages

A profile's `packages` must be in the binary cache on every platform its users run, or the launch stops. Check them ahead of time:

```sh
nix run github:juspay/agent-distro#check-profile                       # ./agent-distro.nix
nix run github:juspay/agent-distro#check-profile -- path/to/agent-distro.nix
```

It runs the launcher's own policy, against agent-distro's nixpkgs and caches, and prints one line per package; it exits 1 if any is not cached, or cannot be told. It checks for the machine it runs on, so run it in CI once per platform.

## Harnesses

Each harness is a directory under [harnesses/](https://github.com/juspay/agent-distro/tree/main/harnesses); its README holds the design notes for that adapter.

| Harness | Command | Notes |
| --- | --- | --- |
| Oh My Pi | `omp` | [design notes](https://github.com/juspay/agent-distro/blob/main/harnesses/omp/README.md) |
| Codex | `codex` | [design notes](https://github.com/juspay/agent-distro/blob/main/harnesses/codex/README.md) |
| Claude Code | `claude` | [design notes](https://github.com/juspay/agent-distro/blob/main/harnesses/claude/README.md) |
| OpenCode | `opencode` | [design notes](https://github.com/juspay/agent-distro/blob/main/harnesses/opencode/README.md) |
| Pi | `pi` | [design notes](https://github.com/juspay/agent-distro/blob/main/harnesses/pi/README.md) |

## How it works

- **Profile.** Harness-independent data: an `agent-distro.nix`, read at launch, or one built with `agent-distro.lib.mkProfile`.
- **Harness.** The agent application.
- **Plugin.** A portable Agent Plugins directory.
- **Environment and settings.** Optional data a profile carries: variables every launch exports, a `secret` one prompted for when it is unset, and what `omp` and `opencode` default. OpenCode's own copy of those models comes from [`opencode-plugin-litellm`](https://github.com/yuseferi/opencode-litellm), vendored in `harnesses/opencode/npins` and loaded by every launch: it discovers a LiteLLM server's `/v1/models` and `/v1/model/info`, prices and limits included, and probes a local one when nothing names it.

Harness design notes live in each directory under [harnesses/](https://github.com/juspay/agent-distro/tree/main/harnesses).

### Runtime

- **TypeScript, no build step.** What runs on your machine beyond the harnesses themselves[^what-runs] is TypeScript under [src/](https://github.com/juspay/agent-distro/tree/main/src), run by Node 24's native type stripping: no `package.json`, bundler or compile step.[^js-entry]
- **Dependencies.** Node comes from the distribution's nixpkgs. Its one npm dependency is `yaml`, for OMP's config.[^yaml-pin]
- **Entry points.** The commands you run, and the shims Home Manager installs, stay small generated shell scripts that call into it. Every launch starts with one call, which resolves the profile in effect ([src/profile/](https://github.com/juspay/agent-distro/tree/main/src/profile)) and prints shell for the launcher: its plugins, its environment and settings, and its packages' `PATH`.

[^what-runs]: The plugin reader, each harness's config writer, the picker and the Home Manager updater.
[^js-entry]: The one exception is that launch entry, plain JavaScript so that it can turn on Node's compile cache before any TypeScript loads.
[^yaml-pin]: A tarball pinned in `lib/npins`, which [lib/runtime.nix](https://github.com/juspay/agent-distro/blob/main/lib/runtime.nix) links in as `node_modules/yaml`.

### Reading plugins

Every plugin is read once, harness-independently, against Agent Plugins 1.0.0, by the same reader and the same harness writers.[^read-when]

- **Invalid manifest.** Fails the build (or the launch) with a message naming the field.
- **Lesser problems.** Skipped skills, disabled `mcp.json` files and invalid server entries are reported in the build log (or on stderr).[^failure-boundaries]
- **Commands.** A bare MCP `command` is found on `PATH`: the profile's `packages` first, then the user's own. A `./` command runs from the plugin.
- **Working directory.** A stdio MCP server starts in the directory the harness was launched in, not the plugin root — a deliberate departure from Agent Plugins §7.2.1, because a plugin from a flake reference lives under `/nix/store` and `nix run github:…` cannot run from there. A server's own `cwd` still wins.

> One known gap: Claude Code expands `${VAR}` in a remote server's `url` and `headers`, which the spec forbids.[^var-gap]

[^read-when]: A profile read at launch, and the directories on `AGENT_DISTRO_PLUGINS`, are read at launch, into the cache described in [Plugins at launch](#plugins-at-launch); a profile built with `mkProfile` is read at build time.
[^failure-boundaries]: As the spec's failure boundaries require.
[^var-gap]: Those values cannot go through a launcher, so a remote server whose URL or headers contain `${` reaches Claude Code as is.

### Shared homes

Profiles share each harness's own home directory, so what OMP persists outlives the profile that wrote it.[^persisted] Claude Code's plugins last only for the session, and a profile read at launch reaches Codex and Pi as `AGENT_DISTRO_PLUGINS` does.

[^persisted]: The model roles a profile filled into OMP's config stay when you launch with no profile. A launch's Codex marketplaces — `agent-distro-<hash>`, one per plugin — are its own: they live in Codex's install cache, and nothing of them reaches `config.toml`.

## Development

```sh
nix build .#default    # the package: the picker, every launcher and share/agent-distro/versions
nix flake check
just test              # offline NixOS VM tests; Linux with KVM
just test-template
just demo              # re-record doc/demo.gif and the website's stills
python3 .github/scripts/test-update-flake.py
```

The TypeScript's own checks need no VM or KVM, and `nix flake check` at the root does not run them. Build them from the test flake:

```sh
cd test && nix build --no-link .#checks.x86_64-linux.{reader,launch-plugins,opencode-standalone,profile-resolve,mk-profile,nixpkgs-reference,omp-adapter,pi-adapter,opencode-adapter,update-schedule,list-json,picker-layout,picker-auth}
```

| Check | Covers |
| --- | --- |
| `reader` | the plugin reader |
| `launch-plugins` | `AGENT_DISTRO_PLUGINS`: cache keys, re-translation, precedence, a profile's plugins replaced by name, and the launches it fails |
| `profile-resolve` | the profile in effect, with a fake nix: discovery, the stack and how it composes, a built profile by its store path (and the reader that decides whether its descriptions are used), references and their offline fallback, the evaluation's isolation, its cache, nixpkgs fetched only for packages, and the no-compile policy |
| `mk-profile` | `agent-distro.lib.mkProfile`'s output: its metadata, its plugins' descriptions and roots, and `bin/` |
| `nixpkgs-reference` | the package names nixpkgs by reference and does not hold its source |
| `opencode-standalone` | an interactive OpenCode launch reaches the harness with `--standalone`, so one launch's config is not served to the next |
| `<harness>-adapter` | a harness's `tests/check-adapter.ts` |
| `update-schedule` | the updater's schedule, cache policy and index (its URL, and which systems take one) |
| `list-json` | `--list --json` against its type and the profile in effect, the chooser's menu and `--list` |
| `picker-layout` | the chooser's cell widths, truncation and box at common terminal sizes |
| `picker-auth` | the auth probes over fixture homes and stores |

### CI

- **Runner.** CI is [odu](https://github.com/juspay/odu): `nix run --accept-flake-config github:juspay/odu -- run` runs the `ci` recipe and everything it depends on — one `<recipe>@<platform>` commit status per node, on the Linux and macOS lane hosts of `~/.config/odu/hosts.json`.
- **Sharding.** The VM tests spread over up to 8 Linux hosts,[^shards] since each wrapper check boots a machine of its own.
- **Required checks.** `just protect --dry-run` prints the contexts main's ruleset requires; `just protect` sets them, from what the pipeline and `cache.yml` say they are.[^protect]
- **Daily sources.** The daily update runs `.github/scripts/update-sources.sh`,[^update-sources] then updates the root and test locks.
- **Report.** The update report reads resolved versions and each harness's release-note metadata.
- **Cache.** `cache.yml` pushes realised paths to the OSS cache,[^attic-token] and publishes the package's content-addressed rewrite with the index that names it, on the `ca-index` branch of this repository, through the `publish-closure` action it shares with kolu ([juspay/kolu#2294](https://github.com/juspay/kolu/pull/2294)) ([The binary cache](#binary-cache)).
- **Merge gate.** The daily update PR enables auto-merge, so it lands once every context the ruleset requires is green.[^auto-merge]
- **Consumers.** They run `nix flake update agent-distro`.

For manual updates, run `bash .github/scripts/update-sources.sh`, `nix flake update`, and then `bash test/update-lock.sh`.

[^update-sources]: It discovers npins directories under `harnesses/` and `lib/`, re-pins each npm tarball pinned there (`yaml`, `opencode-plugin-litellm`) to the newest release of its major version, and runs each harness's `update.py`.
[^shards]: `test` carries `[metadata("odu:shard=8")]`: odu gives each shard `ODU_SHARD_INDEX` and `ODU_SHARD_TOTAL`, and the recipe builds its own slice of `./test`'s checks. With neither variable set it runs them all in one `nix flake check`.
[^protect]: `odu protect` writes [the repository ruleset](https://github.com/juspay/agent-distro/rules/23633532) with exactly the contexts the pipeline posts; the recipe then appends `cache.yml`'s, which odu cannot know since they come from a GitHub workflow rather than the justfile. Run it after merging a change to either side's names.
[^attic-token]: `ATTIC_TOKEN` is needed except on fork PRs, and only here: `cache.yml` stays on GitHub Actions because it is what pushes to the cache, and odu runs the checks without any repository secret.
[^auto-merge]: The update workflow approves the runs GitHub holds back for automation-created pull requests and enables auto-merge, so the PR lands as soon as every context `Require CI on main` requires is green — `cache.yml`'s `build (…)` and `publish (…)`, which that approval starts, and odu's `<recipe>@<platform>`, which someone has to run on the branch.

### Test library

Consumers can import `test/lib.nix { pkgs; nixpkgs ? null; profiles ? [ ]; updated ? profiles; features ? [ ]; koluPlugin ? null; }`, where `nixpkgs` is the flake input `pkgs` came from, so the guest launchers name it by a locked reference rather than hold its source. `profiles` are `mkProfile` derivations, whose store paths are the `AI_PROFILE` the checks launch with; `updated` defaults to `profiles`, and a caller passes the same profiles with their plugins rebuilt to new store paths, for the `changed` fixture. Checks are selected by required features from each harness's metadata;[^features] `picker` is shared.

- **Plugin rebuilds.** Select plugin rebuild checks only for nonempty skill plugins.
- **Coverage.** The test flake covers the package with no profile (with kolu's plugin loaded at launch), the Juspay profile built with `mkProfile`, and spec fixtures, plus `profiles`: profiles read at launch, by path and `git+file:`, from a nested directory, in precedence order, refusing an uncached package, and a repository's `agent-distro.nix` reaching OMP, Codex and Claude Code as the same profile built by `mkProfile` does; and `ca-update`: the update that takes the published content-addressed path as an untrusted user, and the skip where the index publishes none.

[^features]: The features are `plugins`, `gateway` (the checks that run against the fixture-backed LiteLLM profile), `kolu`, `spec`, and `koluLaunch`, which loads `koluPlugin` through `AGENT_DISTRO_PLUGINS`.

### Logo

`doc/logo.svg` is the source vector; downstream consumers (kolu) vendor a copy.

> Keep it transparent, textless, readable at 16 px.

## Adding a harness

Create `harnesses/<name>/` with four files:

| File | Holds |
| --- | --- |
| `meta.nix` | title, order, `auth`,[^auth-values] `releaseNotes = version: URL`, and checks |
| `default.nix` | the adapter, accepting `{ pkgs, name, package, launchPlugins }` — `name` is its own harness name, `launchPlugins` is `runtime.launchPlugins` seeded with it — and starting with `launchPlugins { … }`[^launch-json] |
| `source.nix` | `{ pkgs }` to package |
| `README.md` | design notes |

[^auth-values]: `auth = "anthropic" | "openai"`, for a harness with a login of its own; without one the picker reads the profile's `secret` variables and the harness's own store.
[^launch-json]: The adapter hands `launchPlugins` what it needs for a launch; its shell sets `launched`, `profile_env_*` and `profile_settings` for the profile in effect, read when the harness starts.

- **Alongside.** Pins in `npins/`, scripts in `tests/`, and an optional custom updater in `update.py`.
- **No registration.** Nothing outside this directory needs registration.[^discovery]
- **Logic beyond shell.** Keep it in `src/harness/<name>.ts` and call it with `(import ../../lib/runtime.nix pkgs).script "harness/<name>.ts"`.[^beyond-shell]
- **Unit checks.** Those that need no VM go in `tests/check-adapter.ts`, which receives the runtime's `src` and the harness directory.
- **Checks.** Checks declare `{ name; script; requires ? []; packages ? []; env ? {}; diskSize ? null; }`.[^check-packages] `script` is VM-driver Python.[^guest-script]
- **Gateway checks.** They receive the shared fake service and launchers configured against it.
- **Fixtures.** `mkLaunchers` also accepts a `sources = name: pkgs: …` hook for package fixtures.

[^discovery]: The picker, the package, outputs, reserved names, checks, and daily report all discover it.
[^beyond-shell]: For an adapter that needs more than shell: translating plugin descriptions into the harness's config, merging user state at launch.
[^check-packages]: Packages can name `updated`, `upstream`, `koluFixture`, or `recordFixture`.
[^guest-script]: Use `import ../../test/guest-script.nix ./tests/check.py` to run a guest script as the unprivileged VM user.
