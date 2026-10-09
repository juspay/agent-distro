# Selection only: each launcher owns its initialization and plugin protocol.
# Store-path dispatch holds every launcher in the closure: no flake or network.
#
# One profile per launch, so the picker chooses a harness. The profile in
# effect is resolved here (src/profile/resolve.ts) and handed to the launcher
# in AGENT_DISTRO_PROFILE: a leading positional selector, else the
# repository's agent-distro.nix, else AI_PROFILE, else the built-in profile.
{ lib, pkgs, writeShellApplication, launchers, info }:
let
  runtime = import ./runtime.nix pkgs;
  discovered = import ./discover-harnesses.nix;
  harnesses = discovered.ordered;
  displayVersion = harness: lib.head (lib.splitString "+" launchers.${harness}.version);
  # The one source for `--list`, `--list --json` and the chooser's menu;
  # src/listing.ts types it. `--list --json` adds the profile in effect.
  listing = {
    profiles = [{
      # The built-in profile.
      inherit (lib.head info.builtins) name description;
      harnesses = map
        (harness: {
          name = harness;
          inherit (discovered.metadata.${harness}) title tagline;
          version = displayVersion harness;
        })
        harnesses;
    }];
  };
  menu = builtins.toJSON listing;
  infoFile = pkgs.writeText "agent-distro-profile-info.json" (builtins.toJSON info);
  # Each harness's auth scheme, for the chooser's auth column; a gateway
  # harness's probe needs the profile in effect, so the chooser builds it.
  auth = builtins.toJSON (lib.genAttrs harnesses (harness:
    let meta = discovered.metadata.${harness}; in
    meta.auth or (throw "harnesses/${harness}/meta.nix has no `auth`; add `auth = \"anthropic\" | \"openai\" | \"gateway\"`.")));
  block = indent: lines: lib.concatMapStrings (line: "\n${indent}${line}") lines;
  arms = block "    " (map (harness: "${harness}) exec ${lib.getExe launchers.${harness}} \"$@\" ;;") harnesses);
  builtinNames = map (b: b.name) info.builtins;
  quote = lib.escapeShellArg;
  noTty = [ "Set AI_HARNESS to ${lib.concatStringsSep ", " (lib.init harnesses)}, or ${lib.last harnesses}, use agent-distro <harness>, or run this from a terminal." ];
in
writeShellApplication {
  name = "agent-distro";
  passthru = { inherit listing; info = infoFile; };
  text = ''
    invalid=${quote "Invalid AI_HARNESS; valid values: ${lib.concatStringsSep ", " harnesses}."}

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
        *) echo "usage: agent-distro --list [--json]" >&2; exit 2 ;;
      esac
    fi

    # A leading harness is the harness; otherwise a built-in profile name, or
    # anything with / or : (a path or flake reference), is the profile.
    # Options are the harness's, and -- ends selection.
    selected_profile=""
    selected_harness=""
    case "''${1-}" in
      ${lib.concatStringsSep "|" harnesses}) selected_harness=$1; shift ;;
      -*) ;;
      ${lib.concatStringsSep "|" (map quote builtinNames)}|*/*|*:*) selected_profile=$1; shift ;;
    esac
    if [ -n "$selected_profile" ]; then
      case "''${1-}" in
        ${lib.concatStringsSep "|" harnesses}) selected_harness=$1; shift ;;
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
