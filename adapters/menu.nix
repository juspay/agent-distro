# The distribution's front door: pick a profile, then hand the arguments to
# that profile's harness picker.
#
# Every picker is an ordinary derivation in the same evaluation as this script,
# so choosing one is a store path substitution, not a second `nix run`. The
# menu therefore needs no flake reference, no network, and no `--impure`: it
# costs a build of every profile, and buys an entry point that cannot resolve
# to something the lock did not already describe.
{ lib, writeShellApplication, gum, launchers, profiles, default }:
let
  names = lib.attrNames launchers;
  # "a", "a or b", "a, b, or c" — prose for the error messages, which name the
  # profiles that exist rather than telling the reader to go and look.
  prose =
    if builtins.length names < 2 then lib.concatStrings names
    else lib.concatStringsSep ", " (lib.init names)
      + (if builtins.length names > 2 then ", or " else " or ")
      + lib.last names;
  entry = name: lib.escapeShellArg "${name} — ${profiles.${name}.description}\t${name}";
  # Two spaces: the `case` these arms belong to sits at the left margin once Nix
  # strips the indentation shared by every line of `text`.
  branches = lib.concatMapStrings
    (name: "\n  ${lib.escapeShellArg name}) exec ${lib.getExe launchers.${name}.picker} \"$@\" ;;")
    names;
in
writeShellApplication {
  name = "ai";
  runtimeInputs = [ gum ];
  # The default profile's launchers, unwrapped. The daily update reads the
  # harness versions from here now that the menu is the only package, and it
  # saves anyone scripting against one harness a trip through two menus.
  passthru.harnesses = { inherit (launchers.${default}) omp codex claude; };
  text = builtins.readFile ./choose.sh + ''

    invalid=${lib.escapeShellArg "Invalid AI_PROFILE; valid values: ${lib.concatStringsSep ", " names}."}
    choice=""
    ai_choose AI_PROFILE ${lib.escapeShellArg default} 'Choose a profile:' "$invalid" \
      ${lib.escapeShellArg "Set AI_PROFILE to ${prose}, or run this from a terminal."} \
      ${lib.concatStringsSep " " (map entry names)}

    case "$choice" in${branches}
      *) echo "$invalid" >&2; exit 1 ;;
    esac
  '';
}
