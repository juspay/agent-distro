# Selection only: each launcher owns its initialization and plugin protocol.
#
# One list of every profile's harnesses. Each launcher is a derivation in this
# same evaluation, so a choice resolves to a store path the closure already
# holds — no flake reference, no network, no `--impure`. A single-profile
# distribution is this same list with one profile's rows and no profile tags.
{ lib, writeShellApplication, gum, profiles, default }:
let
  names = [ default ] ++ lib.remove default (lib.attrNames profiles);
  others = lib.remove default names;
  harnesses = [ "omp" "codex" "claude" ];
  titles = { omp = "Oh My Pi"; codex = "Codex"; claude = "Claude Code"; };

  # OMP is the only harness a gateway applies to; the other two log in as
  # themselves, which is worth saying beside their names.
  ownLogin = name: harness:
    harness != "omp" && (profiles.${name}.profile.gateway or null) != null;

  # The shell words for one list of `{ name; tagged; }`. The "(own login)"
  # column is measured across the rows that list actually shows, so a list
  # narrowed to one profile does not inherit a wider list's gap.
  listRows = entries:
    let
      title = entry: harness: lib.optionalString entry.tagged "${entry.name} · " + titles.${harness};
      column = 4 + lib.foldl' lib.max 0 (map lib.stringLength (lib.concatMap
        (entry: map (title entry) (lib.filter (ownLogin entry.name) harnesses))
        entries));
      label = entry: harness:
        let text = title entry harness; in
        text + lib.optionalString (ownLogin entry.name harness)
          (lib.concatStrings (lib.genList (_: " ") (column - lib.stringLength text)) + "(own login)");
    in
    lib.concatMapStringsSep " "
      (entry: lib.concatMapStringsSep " "
        (harness: lib.escapeShellArg "${label entry harness}\t${entry.name}/${harness}")
        harnesses)
      entries;

  # Nix strips the indentation shared by every line of `text`, so these arms
  # carry the depth their `case` ends up at.
  block = indent: lines: lib.concatMapStrings (line: "\n${indent}${line}") lines;
  arms = block "    " (lib.concatMap
    (name: map (harness:
      "${name}/${harness}) exec ${lib.getExe profiles.${name}.launchers.${harness}} \"$@\" ;;")
      harnesses)
    names);
  # AI_PROFILE narrows the list to one profile, whose description is the header.
  narrowed = block "  " (map
    (name: "${lib.escapeShellArg name}) header=${
      lib.escapeShellArg "${profiles.${name}.profile.description}\n"
    }; rows=(${listRows [{ inherit name; tagged = false; }]}) ;;")
    names);

  quote = lib.escapeShellArg;
  noTty = [ "Set AI_HARNESS to omp, codex, or claude, or run this from a terminal." ]
    ++ lib.optional (others != [ ])
    "Set AI_PROFILE to one of ${lib.concatStringsSep ", " names}; it defaults to ${default}.";
  # Only a registry of several profiles has a wider list to fall back to.
  whole = lib.optionalString (others != [ ]) ''

    if [ "''${AI_PROFILE+x}" != x ]; then
      rows=(${listRows ([{ name = default; tagged = false; }]
        ++ map (name: { inherit name; tagged = true; }) others)})
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
    ${whole}
    choice=$(gum choose --limit 1 --label-delimiter $'\t' --cursor '❯ ' --no-show-help \
      --cursor.foreground 4 --selected.foreground 4 --header.foreground= \
      --header "$header" "''${rows[@]}") || exit 0
    if [ -n "$choice" ]; then
      launch "$choice" "$@"
    fi
  '';
}
