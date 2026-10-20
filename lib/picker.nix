# Selection only: each launcher owns its initialization and plugin protocol.
# Store-path dispatch holds every launcher in the closure: no flake or network.
#
# One package, so every launch is a harness. The profile in effect is resolved
# here (src/profile/resolve.ts) and handed to the launcher in
# AGENT_DISTRO_PROFILE: a leading positional selector, else the repository's
# profile — a `plugin.json` — over every AI_PROFILE entry.
{ lib, pkgs, writeShellApplication, launchers, nixpkgs ? null }:
let
  runtime = import ./runtime.nix pkgs;
  discovered = import ./discover-harnesses.nix;
  # The one list the package is built from: the menu's harnesses are the
  # discovered ones, which are the launchers beside this picker and the
  # `versions` file the package ships (lib/mk-launchers.nix) — one expression,
  # so the three cannot drift. Each version is read from the launcher's own
  # derivation, and only when something asks for it.
  harnesses = map
    (name: {
      inherit name;
      inherit (discovered.metadata.${name}) title tagline;
      # The display version, without the package's `+` revision suffix.
      version = lib.head (lib.splitString "+" launchers.${name}.version);
    })
    discovered.ordered;
  names = map (harness: harness.name) harnesses;
  # The one source for `--list`, `--list --json` and the chooser's menu;
  # src/listing.ts types it. `--list --json` adds the profile in effect.
  listing = { inherit harnesses; };
  menu = builtins.toJSON listing;
  infoFile = pkgs.writeText "agent-distro-info.json" (builtins.toJSON (runtime.info nixpkgs));
  # Each harness's auth scheme, for the chooser's auth column: the harnesses
  # with a login of their own name it in meta.nix, the rest are the profile's
  # `secret` variables and the harness's own store, which needs the profile in
  # effect, so the chooser builds it.
  auth = builtins.toJSON (lib.genAttrs names (harness: discovered.metadata.${harness}.auth or "secrets"));
  block = indent: lines: lib.concatMapStrings (line: "\n${indent}${line}") lines;
  arms = block "    " (map (harness: "${harness}) exec ${lib.getExe launchers.${harness}} \"$@\" ;;") names);
  quote = lib.escapeShellArg;
  noTty = [ "agent-distro picker: error: set AI_HARNESS to ${lib.concatStringsSep ", " (lib.init names)}, or ${lib.last names}, use agent-distro <harness>, or run this from a terminal." ];
in
writeShellApplication {
  name = "agent-distro";
  # Not `info`: NixOS installs a package's `info` as its texinfo output.
  passthru = { inherit listing infoFile; };
  text = ''
    invalid=${quote "agent-distro picker: error: invalid AI_HARNESS; valid values: ${lib.concatStringsSep ", " names}."}

    launch() {
      local target=$1
      shift
      case "$target" in${arms}
        *) echo "$invalid" >&2; exit 1 ;;
      esac
    }

    if [ "''${1-}" = --list ]; then
      case "$#:''${2-}" in
        1:) exec ${runtime.script "profile/cli.ts"} list ${infoFile} ${quote menu} ;;
        2:--json) exec ${runtime.script "profile/cli.ts"} list ${infoFile} ${quote menu} --json ;;
        *) echo "agent-distro picker: usage: agent-distro --list [--json]" >&2; exit 2 ;;
      esac
    fi

    # A leading harness is the harness; otherwise anything with / or : (a path
    # or a flake reference) is the profile. Options are the harness's, and --
    # ends selection.
    selected_profile=""
    selected_harness=""
    case "''${1-}" in
      ${lib.concatStringsSep "|" names}) selected_harness=$1; shift ;;
      -*) ;;
      */*|*:*) selected_profile=$1; shift ;;
    esac
    if [ -n "$selected_profile" ]; then
      case "''${1-}" in
        ${lib.concatStringsSep "|" names}) selected_harness=$1; shift ;;
      esac
    fi
    if [ "''${1-}" = -- ]; then shift; fi

    # The launcher would resolve the same profile, but for the positional
    # selector, which only this command reads.
    AGENT_DISTRO_PROFILE=$(${runtime.script "profile/cli.ts"} resolve ${infoFile} "$selected_profile")
    export AGENT_DISTRO_PROFILE

    # Environment wins over the positional harness.
    if [ "''${AI_HARNESS+x}" = x ]; then
      launch "$AI_HARNESS" "$@"
    fi
    if [ -n "$selected_harness" ]; then
      launch "$selected_harness" "$@"
    fi

    if [ ! -t 0 ]; then
      printf '%s\n' ${lib.concatMapStringsSep " " quote noTty} >&2
      exit 1
    fi

    state_dir="''${XDG_STATE_HOME:-$HOME/.local/state}/agent-distro"
    remembered=""
    if [ -r "$state_dir/last-choice" ]; then
      IFS= read -r remembered < "$state_dir/last-choice" || true
    fi
    # Quitting prints nothing and exits 0; any other failure keeps its status.
    choice=$(${runtime.script "picker/choose.ts"} ${quote menu} --auth ${quote auth} --profile "$AGENT_DISTRO_PROFILE" --remembered "$remembered") || exit
    if [ -n "$choice" ]; then
      # Only the chooser reaches here; direct selections never update state.
      # A failed state write must never prevent launching the selected agent.
      (
        mkdir -p "$state_dir" || exit 0
        temporary=$(mktemp "$state_dir/.last-choice.XXXXXX") || exit 0
        trap 'rm -f "$temporary"' EXIT
        printf '%s\n' "$choice" > "$temporary" || exit 0
        mv -f "$temporary" "$state_dir/last-choice"
      ) 2>/dev/null || true
      launch "$choice" "$@"
    fi
  '';
}
