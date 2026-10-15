# Pi's subcommands require resources in settings, not prepended CLI flags.
{ pkgs, nixpkgs, package }:
let
  inherit (pkgs) lib writeShellApplication runCommand gum;
  pi = package;

  runtime = import ../../lib/runtime.nix pkgs;
  config = runCommand "pi-config" { } ''
    ${runtime.script "harness/pi.ts"} write-config "$out"
  '';
  launchPlugins = runtime.launchPlugins (runtime.info nixpkgs // {
    harness = "pi";
    config = "${config}";
  });
in
writeShellApplication {
  name = "pi";
  derivationArgs.version = pi.version;
  text = ''
    # The profiles in effect, their env and packages, and its fragment, with
    # the plugins they and AGENT_DISTRO_PLUGINS name merged in; loading plugins
    # other than the profile's fails without a home to merge them into.
    ${launchPlugins}
    fragment=$launched
    ${import ../../lib/prompt-secrets.nix { inherit gum; }}
    if [ -n "''${PI_CODING_AGENT_DIR:-}''${HOME:-}" ]; then
      agent_dir="''${PI_CODING_AGENT_DIR:-''${HOME:-}/.pi/agent}"
      status=0
      ${runtime.script "harness/pi.ts"} merge-state --check "$agent_dir" "$fragment" || status=$?
      if [ "$status" = 1 ]; then exit 1; fi
      if [ "$status" = 2 ] && [ "$fragment" != ${config}/config.json ]; then
        echo 'agent-distro pi: error: cannot load AGENT_DISTRO_PLUGINS: the agent directory cannot be written.' >&2
        exit 1
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
