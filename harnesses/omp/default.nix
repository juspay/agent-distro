# OMP owns LiteLLM initialization and portable extension loading.
{ pkgs, plugins, gateway, package, profileName, nixpkgs ? null }:
let
  inherit (pkgs) lib writeShellApplication formats gum;
  omp = package;

  ensureApiKey = import ../../lib/gateway-key.nix { inherit gum; };
  # Defaults are merged only into absent keys, preserving /model and /settings
  # choices. src/harness/omp.ts round-trips the YAML to retain comments and
  # quoted values.
  runtime = import ../../lib/runtime.nix pkgs;
  # Thinking blocks are transcript content, not the thinking-level indicator;
  # hide them for every profile, gateway or not. A user-set value, including
  # `false`, is never replaced.
  alwaysDefaults = (formats.yaml { }).generate "omp-config.yml" {
    hideThinkingBlock = true;
  };
  launchPlugins = runtime.launchPlugins {
    harness = "omp";
    inherit gateway profileName nixpkgs;
    profile = map (plugin: { description = "${runtime.readPlugin plugin}"; dir = "${plugin}"; }) plugins;
  };

  initialization = ''
    # The profile in effect, its gateway and packages, and every plugin's root.
    launch=$(${launchPlugins})
    eval "$launch"
    agent_dir="''${PI_CODING_AGENT_DIR:-''${HOME:-}/.omp/agent}"
    default_layers=("${alwaysDefaults}")
    if [ -n "$profile_gateway" ]; then
      if [ "''${JUSPAY:-1}" = "0" ]; then
        echo 'JUSPAY=0 is deprecated; use AI_GATEWAY=0 instead.' >&2
      fi
      if [ "''${AI_GATEWAY:-1}" != "0" ] && [ "''${JUSPAY:-1}" != "0" ]; then
        # Roles on the gateway's models, and the resolved-model badge (src/harness/omp.ts).
        default_layers+=(--gateway "$profile_gateway")
        ${ensureApiKey}

        # These two are how OMP finds the gateway and asks it what it serves, so the
        # model list is the gateway's, not a copy we maintain.
        export LITELLM_BASE_URL="$profile_gateway_url"
        # Kept even though the agent dir now persists and the wizard would only
        # run once. Everything it asks — provider, key, model — the wrapper has
        # already answered above, so the one run it would get is a run spent
        # re-entering the key we just prompted for. An explicitly forced setup
        # (`omp setup`) still works.
        export OMP_SKIP_SETUP=1
      fi
    fi

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
  # `launched` and `profile_gateway*` are assigned by the launch's eval.
  excludeShellChecks = [ "SC2154" ];
  text = ''
    ${initialization}

    # The profile's roots, less those AGENT_DISTRO_PLUGINS replaces, then its
    # own. CLI roots compose with the user's extensions; config arrays replace them.
    eval "set -- $launched \"\$@\""
    exec ${lib.getExe omp} "$@"
  '';
}
