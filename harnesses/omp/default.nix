# OMP owns LiteLLM initialization and portable extension loading.
{ pkgs, plugins, gateway, package, profileName }:
let
  inherit (pkgs) lib writeShellApplication formats gum;
  omp = package;

  ensureApiKey = import ../../lib/gateway-key.nix { inherit gum gateway; };
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
  gatewayDefaults = (formats.yaml { }).generate "omp-config-gateway.yml" {
    # Without this OMP starts on its own first-available model; the roles are how
    # our recommendation reaches the agent.
    modelRoles = {
      default = "litellm/${gateway.models.large}";
      smol = "litellm/${gateway.models.small}";
      task = "litellm/${gateway.models.large}";
      slow = "litellm/${gateway.models.large}";
    };
    # OMP ships this off, so a subagent's row names the agent and nothing else:
    # which model a worker or reviewer actually resolved to is invisible. Our
    # roles point at gateway aliases (`open-large`), and an agent can carry its
    # own model override, so the badge is the only place that answer surfaces.
    task.showResolvedModelBadge = true;
  };

  launchPlugins = runtime.launchPlugins {
    harness = "omp";
    profile = map (plugin: { description = "${runtime.readPlugin plugin}"; dir = "${plugin}"; }) plugins;
  };

  initialization = ''
    agent_dir="''${PI_CODING_AGENT_DIR:-''${HOME:-}/.omp/agent}"
    default_layers=("${alwaysDefaults}")
    ${lib.optionalString (gateway != null) ''
      if [ "''${JUSPAY:-1}" = "0" ]; then
        echo 'JUSPAY=0 is deprecated; use AI_GATEWAY=0 instead.' >&2
      fi
      if [ "''${AI_GATEWAY:-1}" != "0" ] && [ "''${JUSPAY:-1}" != "0" ]; then
        default_layers+=("${gatewayDefaults}")
        ${ensureApiKey}

        # These two are how OMP finds the gateway and asks it what it serves, so the
        # model list is the gateway's, not a copy we maintain.
        export LITELLM_BASE_URL=${lib.escapeShellArg gateway.url}
        # Kept even though the agent dir now persists and the wizard would only
        # run once. Everything it asks — provider, key, model — the wrapper has
        # already answered above, so the one run it would get is a run spent
        # re-entering the key we just prompted for. An explicitly forced setup
        # (`omp setup`) still works.
        export OMP_SKIP_SETUP=1
      fi
    ''}

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

    if [ -n "''${AGENT_DISTRO_PLUGINS:-}" ]; then
      # The profile's roots, less those AGENT_DISTRO_PLUGINS replaces, then its own.
      extensions=$(${launchPlugins})
      eval "set -- $extensions \"\$@\""
      exec ${lib.getExe omp} "$@"
    fi
    # CLI roots compose with the user's extensions; config arrays replace them.
    exec ${lib.getExe omp} ${lib.concatMapStringsSep " " (plugin: "-e ${lib.escapeShellArg "${plugin}"}") plugins} "$@"
  '';
}
