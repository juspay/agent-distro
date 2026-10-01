# Selection only: each launcher owns its initialization and plugin protocol.
# Store-path dispatch holds every launcher in the closure: no flake or network.
{ lib, writeShellApplication, python3, profiles, default }:
let
  names = [ default ] ++ lib.remove default (lib.attrNames profiles);
  discovered = import ./discover-harnesses.nix;
  harnesses = discovered.ordered;
  rows = map (name: {
    inherit name;
    inherit (discovered.metadata.${name}) title tagline;
    version = profiles.${default}.launchers.${name}.version;
  }) harnesses;
  menu = builtins.toJSON {
    inherit default;
    harnesses = rows;
    profiles = map (name: { inherit name; inherit (profiles.${name}.profile) description; }) names;
  };
  block = indent: lines: lib.concatMapStrings (line: "\n${indent}${line}") lines;
  arms = block "    " (lib.concatMap
    (name: map
      (harness:
        "${name}/${harness}) exec ${lib.getExe profiles.${name}.launchers.${harness}} \"$@\" ;;")
      harnesses)
    names);
  quote = lib.escapeShellArg;
  noTty = [ "Set AI_HARNESS to ${lib.concatStringsSep ", " (lib.init harnesses)}, or ${lib.last harnesses}, use ai <harness>, or run this from a terminal." ]
    ++ lib.optional (lib.length names > 1)
    "Set AI_PROFILE to one of ${lib.concatStringsSep ", " names}; it defaults to ${default}.";
  listing = lib.concatMapStringsSep "\n" (profile: lib.concatMapStringsSep "\n"
    (row: "${profile} ${row.name} ${row.title} ${profiles.${profile}.launchers.${row.name}.version}") rows) names;
in
writeShellApplication {
  name = "ai";
  runtimeInputs = [ python3 ];
  passthru.rows = rows;
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
      printf '%s\n' ${quote listing}
      exit 0
    fi

    positional=0
    selected_profile=""
    selected_harness=""
    case "''${1-}" in
      ${lib.concatStringsSep "|" names}) selected_profile=$1; positional=1; shift ;;
      ${lib.concatStringsSep "|" harnesses}) selected_harness=$1; positional=1; shift ;;
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
    menu=$(python3 -c '
    import json, sys
    data = json.loads(sys.argv[1])
    if sys.argv[2]:
        data["profiles"] = [p for p in data["profiles"] if p["name"] == sys.argv[2]]
    data["remembered"] = sys.argv[3]
    print(json.dumps(data))
    ' ${quote menu} "$narrow" "$remembered")
    choice=$(python3 ${./picker/choose.py} "$menu") || exit 0
    if [ -n "$choice" ]; then
      if [ "$positional" = 0 ]; then
        # A failed state write must never prevent launching the selected agent.
        (
          mkdir -p "$state_dir" || exit 0
          temporary=$(mktemp "$state_dir/.last-choice.XXXXXX") || exit 0
          trap 'rm -f "$temporary"' EXIT
          printf '%s\n' "$choice" > "$temporary" || exit 0
          mv -f "$temporary" "$state_dir/last-choice"
        ) 2>/dev/null || true
      fi
      launch "$choice" "$@"
    fi
  '';
}
