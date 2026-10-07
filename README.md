<img src="doc/logo.svg" width="96" alt="agent-distro logo">

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

With several profiles, the chooser has two panes: profiles on the left, with
the highlighted profile's description under them, and that profile's harnesses
on the right, each with its tagline and version. Moving through profiles
previews their harnesses; Enter or Tab moves to the harness pane (here with
`juspay/claude` remembered from last time):

```
╭─ agent-distro ───────┬───────────────────────────────────────────────────────────── 2 profiles · 6 harnesses ─╮
│ Profiles             │ Harnesses · juspay                                                                     │
│ ❯ • juspay           │     Oh My Pi     gateway or own provider · extensions       LITELLM_API_KEY    18.6.3  │
│     vanilla          │     Codex        OpenAI login · plugins via marketplace     ChatGPT           0.160.1  │
│                      │ ❯ • Claude Code  Anthropic login · plugin dirs per session  me@example.com    2.1.291  │
│ Juspay skills +      │     OpenCode     v1 · gateway or own provider               LITELLM_API_KEY   1.18.34  │
│ Kolu, via Juspay's   │     OpenCode v2  v2 preview · private server per launch     LITELLM_API_KEY    2.0.24  │
│ LiteLLM gateway      │     Pi           OMP's upstream · gateway via models.json   LITELLM_API_KEY     1.0.4  │
├──────────────────────┴────────────────────────────────────────────────────────────────────────────────────────┤
│ / filter…                                                                                                     │
╰───────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
↑↓ jk move   Enter launch   ← profiles   Tab switch pane   / filter   q quit
```

| Variable (names unchanged for script compatibility) | Values | Effect |
| --- | --- | --- |
| `AI_HARNESS` | a directory under `harnesses/` | Launches that harness without the list; also usable in scripts and non-interactive shells |
| `AI_PROFILE` | a directory under `profiles/` | Chooses the profile, defaulting to the one `registry.nix` names; on its own, narrows the list to that profile |
| `AI_GATEWAY` | `0` | Keeps the plugins but skips gateway initialization |
| `AGENT_DISTRO_PLUGINS` | `:`-separated plugin directories | Loads more plugins for that launch; see [Plugins at launch](#plugins-at-launch) |

Use `agent-distro <harness>` to launch directly, `agent-distro <profile> <harness>` to select
both, or `agent-distro <profile>` to narrow the chooser. For example:

```sh
agent-distro codex --version
agent-distro juspay claude --version
agent-distro juspay
agent-distro --list                      # profile harness title version, one row per line
agent-distro --list --json               # the same, as JSON (below)
```

`AI_HARNESS` and `AI_PROFILE` take precedence over positional selections;
the profile otherwise defaults to the registry default. Recognized leading
names are consumed; other arguments and everything after `--` are passed to
the harness unchanged.

Narrowed to one profile (`agent-distro juspay`, `AI_PROFILE`, or a
single-profile distribution), the chooser is the harness pane alone, under the
profile's description. Versions reflect the packages pinned at build time,
without revision suffixes:

```
╭─ agent-distro · juspay ────────────────────────────────────────────────── 6 harnesses ─╮
│ Juspay skills + Kolu, via Juspay's LiteLLM gateway                                     │
│ ❯   Oh My Pi     gateway or own provider · extensions       LITELLM_API_KEY    18.6.3  │
│     Codex        OpenAI login · plugins via marketplace     ChatGPT           0.160.1  │
│     Claude Code  Anthropic login · plugin dirs per session  me@example.com    2.1.291  │
│     OpenCode     v1 · gateway or own provider               LITELLM_API_KEY   1.18.34  │
│     OpenCode v2  v2 preview · private server per launch     LITELLM_API_KEY    2.0.24  │
│     Pi           OMP's upstream · gateway via models.json   LITELLM_API_KEY     1.0.4  │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ / filter…                                                                              │
╰────────────────────────────────────────────────────────────────────────────────────────╯
↑↓ jk move   Enter launch   / filter   q quit
```

The status column between the tagline and the version says whether a harness
can start without a login step. It is presence only: the picker contacts no
provider and checks no token's validity or expiry. Claude Code's status is the
`oauthAccount.emailAddress` in `$CLAUDE_CONFIG_DIR/.claude.json` (default
`~/.claude.json`) or the name of `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`;
Codex reads `$CODEX_HOME/auth.json` (`ChatGPT` for a `tokens` object, otherwise
`OPENAI_API_KEY`) or `OPENAI_API_KEY`; a gateway harness shows its profile's
`gateway.keyEnv`; and a harness using its own provider lists the ids in its
store — OMP's `~/.omp/agent/agent.db`, Pi's `$PI_CODING_AGENT_DIR/auth.json`
(default `~/.pi/agent/auth.json`), OpenCode's
`${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json` — together with the
provider API-key variables it reads from the environment. A harness with
nothing to start from shows a dim `not signed in`; one whose store cannot be
read shows nothing. `AI_GATEWAY=0` puts a gateway harness back on its own
provider. This is a launch-time fact: `--list` and `--list --json` never carry
it.

| Key | Does |
| --- | --- |
| ↑/↓, `j`/`k` | Move |
| Enter | On a profile, show its harnesses; on a harness, launch it |
| Tab | Switch between the profile and harness panes (several profiles only) |
| ←, `h`, Escape | Back to profiles from the harness pane; on the first pane, quit |
| `/` | Filter the focused pane by title or tagline (a profile's name or description) |
| Escape (filtering) | Clear the filter, keeping the cursor on its row |
| `q`, Ctrl-C | Quit without choosing |

While filtering, the filter line shows the query as typed and how many rows
match; ↑/↓ still move, Backspace edits, and Enter takes the highlighted match.
The footer lists only the keys that apply at that moment. Colour follows
[`NO_COLOR`](https://no-color.org) and the terminal type. Small or
unsupported terminals (`TERM` unset or `dumb`, no controlling terminal, or
fewer rows or columns than the box needs) get a numbered list on stderr
instead. A terminal that shrinks below that once the box is up shows a notice
until it grows again, with the cursor and filter kept. Without a terminal on
stdin, agent-distro says which variables to set instead of drawing anything.

An interactive selection is remembered in
`${XDG_STATE_HOME:-$HOME/.local/state}/agent-distro/last-choice`. Next time,
the chooser starts on that profile and then on that harness, both marked with
`•`.
Every interactive choice updates it, including `agent-distro <profile>`. Direct selections
with `AI_HARNESS`, `agent-distro <harness>`, or `agent-distro <profile> <harness>` never update it.
An unavailable state directory is silently ignored.

`agent-distro --list --json` prints what the chooser draws, for programs that
offer the same choice (such as [kolu](https://github.com/juspay/kolu)), on one
line. Its shape is stable, typed as `Listing` in [src/listing.ts](./src/listing.ts);
here it is pretty-printed, with each profile cut to one harness:

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

The first profile is the default, and `harnesses` is in menu order. Keys
within an object are sorted. Each `name` is unique at its level, free of
whitespace and `/`, and is what `AI_PROFILE` or `AI_HARNESS` (or a positional
selector) takes;
and `version` is the display version, as `--list` prints it, without the
package's `+` revision suffix. The plain `--list` and the chooser read the
same value, so the three cannot disagree. `--list` takes no other arguments.

### Plugins at launch

A profile fixes the plugins its harnesses start with. Put more [Agent
Plugins](https://agent-plugins.org) directories on `AGENT_DISTRO_PLUGINS`, and
every harness loads them too, in every profile, for that launch:

```sh
AGENT_DISTRO_PLUGINS=~/src/my-plugin agent-distro claude
AGENT_DISTRO_PLUGINS=/nix/store/…-kolu/agent-plugin:~/src/my-plugin agent-distro juspay omp
```

- **Entries.** Directories separated by `:`, so a path containing `:` cannot
  be given; empty components are ignored. A relative entry is resolved against
  the directory the launcher starts in, and symlinks are followed. `~` is
  expanded by the shell, and only where an assignment expands it: unquoted,
  in bash or zsh, not in fish. An entry that is not a directory fails the
  launch, naming it.
- **Read like a profile's plugins.** Each directory goes through the same
  reader: an invalid manifest fails the launch with a message naming the
  field, and skipped skills, a disabled `mcp.json` or an invalid server entry
  are reported on stderr, on every launch, while the launch goes on.
- **Matched by name, never by version.** A plugin whose `plugin.json` `name`
  matches one of the profile's replaces it; on the variable, the last of a
  name wins. No `version` is compared.
- **Translated once.** Each harness's translation of a plugin is cached under
  `${XDG_CACHE_HOME:-~/.cache}/agent-distro/plugins/<key>/<harness>/`, which
  must be an absolute path. A plugin under `/nix/store` is keyed by its store
  path, as is, without reading it. Any other directory is keyed by a hash of
  its contents (its NAR serialization, computed without Nix, leaving out a
  top-level `.git`) and of its absolute path, so an edited checkout is
  translated again on its next launch, and a key is particular to one machine
  and user. That directory is hashed in full on every launch: a large tree
  (a `node_modules`, say) costs launch time, and a FIFO or an unreadable file
  in it fails the launch. A launch never calls Nix, and a cache it cannot
  write fails it.
- **Kept while in use.** Each launch marks the translations it uses. A launch
  that translates something new removes what no launch has used for 14 days,
  so old versions of an edited checkout and translations for an older
  agent-distro do not pile up. With no harness running, removing
  `~/.cache/agent-distro/plugins` is always safe.
- **For that launch only.** Unset the variable and the harness is back to the
  profile's plugins: Claude Code and OMP take them as arguments, OpenCode in its
  session config, and Codex through `-c` overrides; Codex keeps an inert copy
  in its plugin cache, removed once unused for 14 days. Pi only reads its own
  files, so it records what a launch added and its next launch, whenever that
  is, takes it back. Each harness's README says how.

Unset or empty, the launchers behave exactly as they do without this feature.

Supported systems: `x86_64-linux`, `aarch64-linux`, and `aarch64-darwin`.

This flake names a binary cache in its `nixConfig`. Pass `--accept-flake-config`
to use it; without it, Oh My Pi is built from source. The Home Manager
updater below handles the cache itself.

## Install

Puts every harness on your `PATH` and updates them four times a day, at
02:00, 08:00, 14:00 and 20:00 UTC, two hours after upstream's update. With Home Manager:

```nix
{
  imports = [ inputs.agent-distro.homeManagerModules.default ];
  services.agent-distro = {
    enable = true;
    profile = "vanilla"; # default: juspay
  };
}
```

Without Home Manager, update by hand:

```sh
nix profile install github:juspay/agent-distro#juspay
nix profile upgrade juspay
```

Without Home Manager you can still update, cache-only, but you own the driving:
`agent-distro.lib.mkUpdater` (see [Library](#library)) gives the `command` and a
runnable `program` (never compiling; it passes nix only `substituters`), and
`agent-distro.lib.mkShims` keeps installed commands pointing at the updated
bundle. The updater schedules nothing itself — it checks the UTC boundary only
when you pass `--scheduled` (as the module's launchd does), so a non-HM consumer
runs it on its own cadence and must also create the `stateDirectory` itself and
run `--cache-warnings` once to surface an unusable cache. (The updater replaces
`<state>/current` directly, so there is no out-link pruning for the consumer to
do.) Home Manager does the creation and scheduling for you, and at activation its
prune stage deletes sibling state directories left from an earlier flake/profile
choice.

Append `--progress` to `command` to drive the same update from a program that
wants to show the download: stdout is then one JSON object per line —
`{"progress":{"done":<bytes>,"total":<bytes>}}` while nix fetches, then
`{"result":"updated","bundle":"/nix/store/…"}` (or `unchanged`, or `skipped`/
`failed` with a `reason`) — and every human message moves to stderr. Exit codes
and the history log are the same as without it.

The updater never compiles harnesses from source. It passes the project cache
(`cache.nixos.asia/oss`, configurable with `services.agent-distro.substituters`)
to every update, and needs nothing more when you are a trusted Nix user or run
a single-user install. On a multi-user install where you are not trusted, the
daemon ignores that request unless your system config already lists the cache,
so add it to your NixOS or nix-darwin configuration:

```nix
nix.settings.extra-substituters = [ "https://cache.nixos.asia/oss" ];
nix.settings.extra-trusted-public-keys = [ "oss:KO872wNJkCDgmGN3xy9dT89WAhvv13EiKncTtHDItVU=" ];
```

Without it, or when the cache does not yet hold the whole bundle, the update is
skipped, your current version keeps working, and `history.log` records a line
such as `skipped: cache https://cache.nixos.asia/oss not usable; add it to nix.settings substituters/trusted-public-keys`.
The same line is not repeated, and a skip is not retried until the next
scheduled run. Activation warns while the cache is unusable.

Updates not arriving? `systemctl --user status agent-distro-update`; run manually with `systemctl --user start agent-distro-update`. Update and failure events go to `~/.local/state/agent-distro/history.log` in your local timezone, e.g. `2026-10-01T23:03:17+05:30 juspay updated: Pi 0.99.2 → 1.0.0`; unchanged runs add nothing. Full run output is in `journalctl --user -u agent-distro-update` on Linux and `~/.local/state/agent-distro/<source>/update.log` on macOS.

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
agent-distro.lib.mkFlake { profile; systems ? [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ]; cache ? …; }
# → packages.<system>: every harness, default picker, and <profile.name> bundle
#   apps.<system>: every harness and default picker; homeManagerModules.default;
#   lib: the same eight-name library attrset this flake exposes

agent-distro.lib.mkLaunchers { pkgs; profile; }
# → every harness launcher, plus picker and bundle
```

### Library

Beyond the launchers, `agent-distro.lib` exposes the pieces Home Manager uses
under the hood, so any Nix consumer — not only Home Manager — can keep a
profile installed, updated, and chosen. Every function evaluates from a plain
`import` of its `lib/*.nix` file with an arbitrary nixpkgs `pkgs`; a required
argument left out is an eval error naming it.

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

The schedule the updater follows is one `lib/schedule.nix`, exposed as
`agent-distro.lib.schedule`: `updateHoursUTC`, `defaultFrequency`,
`updatePeriodSeconds` and `updateOffsetSeconds`, so the module, `mkUpdater` and
any consumer read the same numbers.

A single-profile distribution draws the narrowed list above — one profile's
rows under its description; `mkFlake` gives you the individual launchers and a
bundle named after the profile, with the picker as its `default`.

`mkFlake` takes an optional `cache = { url; publicKey; }` (default: agent-distro's
cache). The Home Manager updater only installs what that cache holds and never
compiles, so push your own builds to a cache and pass it, or your users' updates
are skipped.

`mkFlake` returns `packages` (every harness, the default picker, and the
`<profile.name>` bundle), `apps`, `homeManagerModules.default`, and the same
`lib` attrset `flake.nix` exposes; add other outputs with `//`.
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
| `vanilla` | Upstream harnesses with your own provider; no plugins, no gateway |
| `juspay` (default) | Juspay skills + Kolu, via Juspay's LiteLLM gateway |

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

What runs on your machine beyond the harnesses themselves (the plugin reader,
each harness's config writer, the picker and the Home Manager updater) is
TypeScript under [src/](./src), run by Node 24's native type stripping: no
`package.json`, bundler or compile step. (The one exception is the entry for
`AGENT_DISTRO_PLUGINS`, plain JavaScript so that it can turn on Node's compile
cache before any TypeScript loads.) Node comes from the distribution's
nixpkgs. Its one npm dependency, `yaml` (for OMP's config), is a tarball
pinned in `lib/npins`, which [lib/runtime.nix](./lib/runtime.nix) links in
as `node_modules/yaml`. The commands you run, and the shims Home Manager
installs, stay small generated shell scripts that call into it.

Every plugin is read once, harness-independently, against Agent Plugins 1.0.0:
a profile's at build time, and one from `AGENT_DISTRO_PLUGINS` at launch, by
the same reader and the same harness writers, into the cache described in
[Plugins at launch](#plugins-at-launch).
An invalid manifest fails the build (or the launch) with a message naming the
field; skipped skills, disabled `mcp.json` files and invalid server entries are
reported in the build log (or on stderr), as the spec's failure boundaries
require. A bare MCP `command` is
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

The TypeScript's own checks need no VM or KVM, and `nix flake check` at the
root does not run them. Build them from the test flake:

```sh
cd test && nix build --no-link .#checks.x86_64-linux.{reader,launch-plugins,omp-adapter,pi-adapter,opencode-adapter,update-schedule,list-json,picker-layout,picker-auth}
```

Daily CI runs `.github/scripts/update-sources.sh`, which discovers npins
directories under `profiles/`, `harnesses/`, and `lib/`, re-pins `yaml` to
the newest npm release of its major version, and runs each harness's `update.py`. CI then updates
the root and test locks. The update report reads
resolved versions and each harness's release-note metadata.

CI pushes realised paths to the OSS cache (`ATTIC_TOKEN` is needed except on
fork PRs). The daily update PR merges only after the required Linux/macOS builds
and VM/template checks pass. The update workflow approves runs GitHub holds
back for automation-created pull requests and squash-merges after the checks
required by `Require CI on main` pass. Superseded PR runs are cancelled.
Consumers run `nix flake update agent-distro`.

For manual updates, run `bash .github/scripts/update-sources.sh`,
`nix flake update`, and then `bash test/update-lock.sh`.

Consumers can import `test/lib.nix { pkgs; launchers; profile; features; koluPlugin ? null; }`.
Checks are selected by required features (`plugins`, `gateway`, `kolu`, `spec`,
and `koluLaunch`, which loads `koluPlugin` through `AGENT_DISTRO_PLUGINS`)
from each harness's metadata; `picker` is shared. Rebuild and gateway checks
also accept `mkLaunchers`. Select plugin rebuild checks only for nonempty skill
plugins. The test flake covers vanilla (with kolu's plugin loaded at launch), Juspay,
and spec fixtures, plus `registry`
(the picker over the whole profile registry). Checks of the TypeScript alone
run without a VM: `reader` (the plugin reader), `launch-plugins`
(`AGENT_DISTRO_PLUGINS`: cache keys, re-translation, precedence and the
launches it fails), `<harness>-adapter` (a
harness's `tests/check-adapter.ts`), `update-schedule` (the updater's
schedule and cache policy), `list-json` (`--list --json` against its
type, the chooser's menu and `--list`), `picker-layout` (the chooser's
cell widths, truncation and box at common terminal sizes), and `picker-auth`
(the auth probes over fixture homes and stores).

### Logo

`doc/logo.svg` is the source vector; downstream consumers (kolu) vendor a copy;
keep it transparent, textless, readable at 16 px.

## Adding a harness

Create `harnesses/<name>/` with four files: `meta.nix` (title, order,
`auth = "anthropic" | "openai" | "gateway"`, `releaseNotes = version: URL`,
and checks), `default.nix` (the adapter accepting
`{ pkgs, plugins, gateway, package, profileName }`), `source.nix` (`{ pkgs }` to
package), and `README.md` (design notes). Put pins in `npins/`, scripts in `tests/`, and an
optional custom updater in `update.py`. Nothing outside this directory needs
registration: the picker, bundles, outputs, reserved names, checks, and daily
report all discover it. The explicit `profileName` argument supports
profile-specific registration, such as Codex’s marketplace name.

An adapter that needs more than shell (translating plugin descriptions into
the harness's config, merging user state at launch) keeps that logic in
`src/harness/<name>.ts` and calls it with
`(import ../../lib/runtime.nix pkgs).script "harness/<name>.ts"`. Unit checks
that need no VM go in `tests/check-adapter.ts`, which receives the runtime's
`src` and the harness directory.

Checks declare `{ name; script; requires ? []; packages ? []; env ? {}; diskSize ? null; }`.
Packages can name `updated`, `upstream`, `koluFixture`, or `recordFixture`.
`script` is VM-driver Python. Use `import ../../test/guest-script.nix ./tests/check.py`
to run a guest script as the unprivileged VM user. Gateway checks receive the shared fake service and
launchers configured against it. `mkLaunchers` also accepts a `sources = name: pkgs: …`
hook for package fixtures.
