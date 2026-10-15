# OMP loads Agent Plugins directories itself.
{ pkgs, nixpkgs, package }:
let
  inherit (pkgs) lib writeShellApplication formats gum;
  omp = package;

  # Defaults are merged only into absent keys, preserving /model /settings
  # choices. src/harness/omp.ts round-trips the YAML to retain comments and
  # quoted values.
  runtime = import ../../lib/runtime.nix pkgs;
  # Thinking blocks are transcript content, not the thinking-level indicator;
  # hide them for every profile. OMP ships the resolved-model badge off, so a
  # subagent's row names the agent and nothing else: which model a worker or
  # reviewer resolved to is invisible, and the badge is the only place that
  # answer surfaces. A user-set value, including `false`, is never replaced.
  alwaysDefaults = (formats.yaml { }).generate "omp-config.yml" {
    hideThinkingBlock = true;
    task.showResolvedModelBadge = true;
  };
  launchPlugins = runtime.launchPlugins (runtime.info nixpkgs // { harness = "omp"; });

  initialization = ''
    # The profiles in effect, their env and settings, their packages and every
    # plugin's root.
    ${launchPlugins}
    agent_dir="''${PI_CODING_AGENT_DIR:-''${HOME:-}/.omp/agent}"
    default_layers=("${alwaysDefaults}")
    # The profile's `settings.omp`, one layer more than the wrapper's own
    # defaults: absent keys only, so /model and /settings choices survive.
    if [ -n "$profile_settings" ]; then
      default_layers+=(--settings "$profile_settings")
    fi
    ${import ../../lib/prompt-secrets.nix { inherit gum; }}

    # Fill absent defaults in the persistent config, including installations
    # created before this wrapper. Existing keys always win, so /model and
    # /settings choices survive relaunch. Invalid YAML stops launch without a
    # write; a directory we cannot write only warns. Honour OMP's relocated
    # agent directory and its default otherwise.
    if [ -n "''${PI_CODING_AGENT_DIR:-}''${HOME:-}" ]; then
      ${runtime.script "harness/omp.ts"} "$agent_dir/config.yml" "''${default_layers[@]}"
    fi
  '';
in
writeShellApplication {
  name = "omp";
  derivationArgs.version = omp.version;
  text = ''
    ${initialization}

    # The profiles' plugin roots, then the ones AGENT_DISTRO_PLUGINS adds.
    # CLI roots compose with the user's extensions; config arrays replace them.
    eval "set -- $launched \"\$@\""
    exec ${lib.getExe omp} "$@"
  '';
}
