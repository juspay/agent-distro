# Selection only: each launcher owns its initialization and plugin protocol.
# Store-path dispatch holds every launcher in the closure: no flake or network.
{ lib, pkgs, writeShellApplication, profiles, default }:
let
  runtime = import ./runtime.nix pkgs;
  names = [ default ] ++ lib.remove default (lib.attrNames profiles);
  discovered = import ./discover-harnesses.nix;
  harnesses = discovered.ordered;
  displayVersion = profile: harness: lib.head (lib.splitString "+" profiles.${profile}.launchers.${harness}.version);
  # The one source for `--list`, `--list --json` and the chooser's menu;
  # src/listing.ts types it.
  listing = {
    inherit default;
    profiles = map
      (name: {
        inherit name;
        inherit (profiles.${name}.profile) description;
        harnesses = map
          (harness: {
            name = harness;
            inherit (discovered.metadata.${harness}) title tagline;
            version = displayVersion name harness;
          })
          harnesses;
      })
      names;
  };
  menu = builtins.toJSON listing;
  block = indent: lines: lib.concatMapStrings (line: "\n${indent}${line}") lines;
  arms = block "    " (lib.concatMap
    (name: map
      (harness:
        "${name}/${harness}) exec ${lib.getExe profiles.${name}.launchers.${harness}} \"$@\" ;;")
      harnesses)
    names);
  quote = lib.escapeShellArg;
  noTty = [ "Set AI_HARNESS to ${lib.concatStringsSep ", " (lib.init harnesses)}, or ${lib.last harnesses}, use agent-distro <harness>, or run this from a terminal." ]
    ++ lib.optional (lib.length names > 1)
    "Set AI_PROFILE to one of ${lib.concatStringsSep ", " names}; it defaults to ${default}.";
  lines = lib.concatMapStringsSep "\n" (profile: lib.concatMapStringsSep "\n"
    (row: "${profile.name} ${row.name} ${row.title} ${row.version}") profile.harnesses) listing.profiles;
in
writeShellApplication {
  name = "agent-distro";
  passthru.listing = listing;
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
      if [ "''${2-}" = --json ]; then
        printf '%s\n' ${quote menu}
      else
        printf '%s\n' ${quote lines}
      fi
      exit 0
    fi

    selected_profile=""
    selected_harness=""
    case "''${1-}" in
      ${lib.concatStringsSep "|" names}) selected_profile=$1; shift ;;
      ${lib.concatStringsSep "|" harnesses}) selected_harness=$1; shift ;;
    esac
    if [ -n "$selected_profile" ]; then
      case "''${1-}" in
        ${lib.concatStringsSep "|" harnesses}) selected_harness=$1; shift ;;
      esac
    fi
    # Environment wins over positional selectors, then the registry default.
    # Only recognized leading selectors are consumed; -- ends picker parsing.
    profile=''${AI_PROFILE-''${selected_profile:-${default}}}
    case "$profile" in
      ${lib.concatStringsSep "|" names}) ;;
      *) echo ${quote "Invalid AI_PROFILE; valid values: ${lib.concatStringsSep ", " names}."} >&2; exit 1 ;;
    esac
    if [ "''${1-}" = -- ]; then shift; fi
    if [ "''${AI_HARNESS+x}" = x ]; then
      launch "$profile/$AI_HARNESS" "$@"
    fi
    if [ -n "$selected_harness" ]; then
      launch "$profile/$selected_harness" "$@"
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
    narrow=""
    if [ "''${AI_PROFILE+x}" = x ] || [ -n "$selected_profile" ]; then narrow=$profile; fi
    choice=$(${runtime.script "picker/choose.ts"} ${quote menu} --profile "$narrow" --remembered "$remembered") || exit 0
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
