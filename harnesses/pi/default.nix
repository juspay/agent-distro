# Pi's subcommands require resources in settings, not prepended CLI flags.
{ pkgs, plugins, gateway, package, profileName }:
let
  inherit (pkgs) lib writeShellApplication runCommand writeText runtimeShell coreutils curl gum;
  pi = package;

  runtime = import ../../lib/runtime.nix pkgs;
  config = runCommand "pi-config" { } ''
    ${runtime.script "harness/pi.ts"} write-config "$out" ${writeText "pi-args.json" (builtins.toJSON {
      inherit gateway;
      bash = runtimeShell;
      env = "${coreutils}/bin/env";
      descriptions = map (plugin: "${runtime.readPlugin plugin}") plugins;
    })}
  '';
  launchPlugins = runtime.launchPlugins {
    harness = "pi";
    bash = runtimeShell;
    env = "${coreutils}/bin/env";
    config = "${config}";
    profile = map (plugin: { description = "${runtime.readPlugin plugin}"; }) plugins;
  };
in
writeShellApplication {
  name = "pi";
  derivationArgs.version = pi.version;
  text = ''
    if [ -n "''${PI_CODING_AGENT_DIR:-}''${HOME:-}" ]; then
      agent_dir="''${PI_CODING_AGENT_DIR:-''${HOME:-}/.pi/agent}"
      fragment=${config}/config.json
      if [ -n "''${AGENT_DISTRO_PLUGINS:-}" ]; then
        # The profile's fragment, less the plugins AGENT_DISTRO_PLUGINS replaces, plus its own.
        fragment=$(${launchPlugins})
      fi
      gateway=()
      ${lib.optionalString (gateway != null) ''
        if [ "''${AI_GATEWAY:-1}" != "0" ]; then
          gateway=(${config}/gateway.json)
        fi
      ''}
      status=0
      ${runtime.script "harness/pi.ts"} merge-state --check "$agent_dir" "$fragment" "''${gateway[@]}" || status=$?
      if [ "$status" = 1 ]; then exit 1; fi
      if [ "$status" = 0 ]; then
        ${lib.optionalString (gateway != null) ''
          if [ "''${AI_GATEWAY:-1}" != "0" ]; then
            ${import ../../lib/gateway-key.nix { inherit gum gateway; }}
            cached=$(${runtime.script "gateway/models.ts"} ${config}/gateway.json \
              "''${XDG_CACHE_HOME:-''${HOME:-$agent_dir}/.cache}/agent-distro/pi/${builtins.hashString "sha256" (toString config)}/models.json" \
              ${curl}/bin/curl ${lib.escapeShellArg gateway.keyEnv} ${./gateway-shape.json})
            gateway=("$cached")
          fi
        ''}
        ${runtime.script "harness/pi.ts"} merge-state --merge "$agent_dir" "$fragment" "''${gateway[@]}"
      fi
    else
      echo 'Pi: warning: HOME and PI_CODING_AGENT_DIR are unset; skipping config merges.' >&2
    fi
    exec ${lib.getExe pi} "$@"
  '';
}
