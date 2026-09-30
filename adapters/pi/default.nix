# Pi owns its persistent state: MCP entries are fused into the user's mcp.json
# (no per-session config exists), and gateway models land in the user's
# models.json. Plugins are loaded per launch with --skill; nothing persists
# except what Pi itself persists.
{ lib, callPackage, writeShellApplication, runCommand, writeText, runtimeShell
, coreutils, curl, gum, python3, pi, plugins, gateway ? null }:
let
  readPlugin = callPackage ../../lib/read-plugin.nix { };
  config = runCommand "pi-config" { } ''
    PYTHONPATH=${../../lib} ${python3.interpreter} ${./write-config.py} "$out" ${runtimeShell} ${coreutils}/bin/env ${writeText "gateway.json" (builtins.toJSON gateway)} ${lib.escapeShellArgs (map (plugin: toString (readPlugin plugin)) plugins)}
  '';
  gatewayInit = gateway:
    let
      ensureApiKey = import ../gateway-key.nix { inherit gum gateway; };
    in
    ''
      if [ "''${AI_GATEWAY:-1}" != "0" ]; then
        ${ensureApiKey}

        agent_dir="''${PI_CODING_AGENT_DIR:-''${HOME:-}/.pi/agent}"
        if [ -z "''${PI_CODING_AGENT_DIR:-}''${HOME:-}" ]; then
          exit 0
        fi
        # Served models extend the aliases; a dead gateway falls back to the
        # cache, then to the aliases themselves. Only our provider entry is
        # ever written, and settings are only filled where the user left them
        # out.
        cache="''${XDG_CACHE_HOME:-''${HOME:-}}/agent-distro/pi/${builtins.hashString "sha256" (toString config)}/models.json"
        PYTHONPATH=${../../lib} ${python3.interpreter} ${./gateway-models.py} "$agent_dir" "$cache" ${lib.escapeShellArg gateway.keyEnv} ${curl}/bin/curl ${config}/models.json
        ${python3.interpreter} ${./fill-config-defaults.py} "$agent_dir/settings.json" ${config}/settings.json
      fi
    '';
  initialization = lib.optionalString (gateway != null) (gatewayInit gateway);
in
writeShellApplication {
  name = "pi";
  derivationArgs.version = pi.version;
  text = ''
    agent_dir="''${PI_CODING_AGENT_DIR:-''${HOME:-}/.pi/agent}"
    ${python3.interpreter} ${./merge-mcp.py} "$agent_dir" ${config}/mcp.json
    ${initialization}
    exec ${lib.getExe pi} ${lib.concatMapStringsSep " " (plugin: "--skill ${lib.escapeShellArg (toString plugin)}") plugins} "$@"
  '';
}