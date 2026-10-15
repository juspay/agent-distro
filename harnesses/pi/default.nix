# Pi's subcommands require resources in settings, not prepended CLI flags.
{ pkgs, name, package, launchPlugins }:
let
  inherit (pkgs) lib writeShellApplication runCommand gum;
  pi = package;

  runtime = import ../../lib/runtime.nix pkgs;
  config = runCommand "pi-config" { } ''
    ${runtime.script "harness/pi.ts"} write-config "$out"
  '';
in
writeShellApplication {
  inherit name;
  derivationArgs.version = pi.version;
  text = ''
    # The profiles in effect, their env and packages, and its fragment, with
    # the plugins they and AGENT_DISTRO_PLUGINS name merged in; loading plugins
    # other than the profile's fails without a home to merge them into.
    ${launchPlugins { config = "${config}"; }}
    fragment=$launched
    ${import ../../lib/prompt-secrets.nix { inherit gum; }}
    if [ -n "''${PI_CODING_AGENT_DIR:-}''${HOME:-}" ]; then
      agent_dir="''${PI_CODING_AGENT_DIR:-''${HOME:-}/.pi/agent}"
      status=0
      ${runtime.script "harness/pi.ts"} merge-state --check "$agent_dir" "$fragment" || status=$?
      if [ "$status" = 1 ]; then exit 1; fi
      # An agent directory that cannot be written skips the merge, with a word:
      # the harness still starts, as it does when there is no home at all.
      if [ "$status" = 2 ]; then
        echo 'agent-distro pi: warning: the agent directory cannot be written; skipping plugin merges.' >&2
      fi
      if [ "$status" = 0 ]; then
        ${runtime.script "harness/pi.ts"} merge-state --merge "$agent_dir" "$fragment"
      fi
    else
      echo 'agent-distro pi: warning: HOME and PI_CODING_AGENT_DIR are unset; skipping config merges.' >&2
    fi
    exec ${lib.getExe pi} "$@"
  '';
}
