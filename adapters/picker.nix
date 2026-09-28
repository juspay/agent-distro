# Selection only: each launcher owns its initialization and plugin protocol.
#
# One list of every profile's harnesses. Each launcher is a derivation in this
# same evaluation, so a choice resolves to a store path the closure already
# holds — no flake reference, no network, no `--impure`.
{ lib, writeShellApplication, gum, profiles, default }:
let
  names = [ default ] ++ lib.remove default (lib.attrNames profiles);
  others = lib.remove default names;
  harnesses = [ "omp" "codex" "claude" ];
  titles = { omp = "Oh My Pi"; codex = "Codex"; claude = "Claude Code"; };

  widest = strings: lib.foldl' lib.max 0 (map lib.stringLength strings);
  pad = width: text: text + lib.concatStrings (lib.genList (_: " ") (width - lib.stringLength text));
  row = name: harness: label: lib.escapeShellArg "${label}\t${name}/${harness}";

  # Narrowed to one profile: its description heads the list, so no row needs a
  # tag.
  narrowRows = name: lib.concatMapStringsSep " "
    (harness: row name harness titles.${harness})
    harnesses;

  # The whole registry has no header, so every row carries its profile, in a
  # column as wide as the widest name.
  profileColumn = 2 + widest names;
  wholeRows = lib.concatMapStringsSep " "
    (name: lib.concatMapStringsSep " "
      (harness: row name harness (pad profileColumn name + titles.${harness}))
      harnesses)
    names;

  # Nix strips the indentation shared by every line of `text`, so these arms
  # carry the depth their `case` ends up at.
  block = indent: lines: lib.concatMapStrings (line: "\n${indent}${line}") lines;
  arms = block "    " (lib.concatMap
    (name: map (harness:
      "${name}/${harness}) exec ${lib.getExe profiles.${name}.launchers.${harness}} \"$@\" ;;")
      harnesses)
    names);
  narrowed = block "  " (map
    (name: "${lib.escapeShellArg name}) header=${
      lib.escapeShellArg "${profiles.${name}.profile.description}\n"
    }; rows=(${narrowRows name}) ;;")
    names);

  quote = lib.escapeShellArg;
  noTty = [ "Set AI_HARNESS to omp, codex, or claude, or run this from a terminal." ]
    ++ lib.optional (others != [ ])
    "Set AI_PROFILE to one of ${lib.concatStringsSep ", " names}; it defaults to ${default}.";
  # Only a registry of several profiles has a wider list to fall back to.
  widen = lib.optionalString (others != [ ]) ''

    if [ "''${AI_PROFILE+x}" != x ]; then
      header=""
      rows=(${wholeRows})
    fi
  '';
in
writeShellApplication {
  name = "ai";
  runtimeInputs = [ gum ];
  text = ''
    invalid=${quote "Invalid AI_HARNESS; valid values: ${lib.concatStringsSep ", " harnesses}."}

    launch() {
      local target=$1
      shift
      case "$target" in${arms}
        *) echo "$invalid" >&2; exit 1 ;;
      esac
    }

    profile=''${AI_PROFILE-${quote default}}
    case "$profile" in${narrowed}
      *) echo ${quote "Invalid AI_PROFILE; valid values: ${lib.concatStringsSep ", " names}."} >&2; exit 1 ;;
    esac

    if [ "''${AI_HARNESS+x}" = x ]; then
      launch "$profile/$AI_HARNESS" "$@"
    fi

    if [ ! -t 0 ]; then
      printf '%s\n' ${lib.concatMapStringsSep " " quote noTty} >&2
      exit 1
    fi
    ${widen}
    choice=$(gum choose --limit 1 --label-delimiter $'\t' --cursor '❯ ' --no-show-help \
      --cursor.foreground 4 --selected.foreground 4 --header.foreground= \
      --header "$header" "''${rows[@]}") || exit 0
    if [ -n "$choice" ]; then
      launch "$choice" "$@"
    fi
  '';
}
