# Pi's subcommands require resources in settings, not prepended CLI flags.
{ pkgs, plugins, gateway, package, profileName }:
let
  inherit (pkgs) lib callPackage writeShellApplication runCommand writeText runtimeShell python3 coreutils curl gum;
  pi = package;

  readPlugin = callPackage ../../lib/read-plugin.nix { };
  config = runCommand "pi-config" { } ''
    PYTHONPATH=${../../lib} ${python3.interpreter} ${./write-config.py} "$out" ${writeText "pi-args.json" (builtins.toJSON {
      inherit gateway;
      bash = runtimeShell;
      env = "${coreutils}/bin/env";
      descriptions = map (plugin: "${readPlugin plugin}") plugins;
    })}
  '';
in
writeShellApplication {
  name = "pi";
  derivationArgs.version = pi.version;
  text = ''
    if [ -n "''${PI_CODING_AGENT_DIR:-}''${HOME:-}" ]; then
      agent_dir="''${PI_CODING_AGENT_DIR:-''${HOME:-}/.pi/agent}"
      gateway=()
      ${lib.optionalString (gateway != null) ''
        if [ "''${AI_GATEWAY:-1}" != "0" ]; then
          gateway=(${config}/gateway.json)
        fi
      ''}
      status=0
      ${python3.interpreter} ${./merge-state.py} --check "$agent_dir" ${config}/config.json "''${gateway[@]}" || status=$?
      if [ "$status" = 1 ]; then exit 1; fi
      if [ "$status" = 0 ]; then
        ${lib.optionalString (gateway != null) ''
          if [ "''${AI_GATEWAY:-1}" != "0" ]; then
            ${import ../../lib/gateway-key.nix { inherit gum gateway; }}
            cached=$(${python3.interpreter} ${../../lib/gateway_models.py} ${config}/gateway.json \
              "''${XDG_CACHE_HOME:-''${HOME:-$agent_dir}/.cache}/agent-distro/pi/${builtins.hashString "sha256" (toString config)}/models.json" \
              ${curl}/bin/curl ${lib.escapeShellArg gateway.keyEnv} ${./gateway-shape.json})
            gateway=("$cached")
          fi
        ''}
        ${python3.interpreter} ${./merge-state.py} --merge "$agent_dir" ${config}/config.json "''${gateway[@]}"
      fi
    else
      echo 'Pi: warning: HOME and PI_CODING_AGENT_DIR are unset; skipping config merges.' >&2
    fi
    exec ${lib.getExe pi} "$@"
  '';
}
