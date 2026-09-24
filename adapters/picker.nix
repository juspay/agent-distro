# Selection only: each launcher owns its initialization and plugin protocol.
{ lib, writeShellApplication, gum, omp, codex, claude, profile }:
let
  ownLogin = lib.optionalString ((profile.gateway or null) != null) " (uses its own login)";
  entry = label: value: lib.escapeShellArg "${label}\t${value}";
in
writeShellApplication {
  name = "ai";
  runtimeInputs = [ gum ];
  text = builtins.readFile ./choose.sh + ''

    invalid='Invalid AI_HARNESS; valid values: omp, codex, claude.'
    choice=""
    # The description heads the menu rather than the program, so a scripted
    # AI_HARNESS run still prints only what the harness prints.
    ai_choose AI_HARNESS omp ${lib.escapeShellArg "${profile.description}\nChoose a coding agent:"} "$invalid" \
      "Set AI_HARNESS to omp, codex, or claude, or run that harness's launcher directly." \
      ${entry "Oh My Pi" "omp"} \
      ${entry "Codex${ownLogin}" "codex"} \
      ${entry "Claude Code${ownLogin}" "claude"}

    case "$choice" in
      omp) exec ${lib.getExe omp} "$@" ;;
      codex) exec ${lib.getExe codex} "$@" ;;
      claude) exec ${lib.getExe claude} "$@" ;;
      *) echo "$invalid" >&2; exit 1 ;;
    esac
  '';
}
