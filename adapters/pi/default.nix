# Pi owns its persistent state: MCP entries, skills and gateway models are all
# fused into the user's agent directory (no per-session config exists), by
# pi-state.py on every launch. Plugins' MCP servers and skills come from that
# fused state; nothing is passed on the command line — Pi's other subcommands
# break when a global option precedes them.
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
      fi
    '';
  initialization = lib.optionalString (gateway != null) (gatewayInit gateway);
in
writeShellApplication {
  name = "pi";
  derivationArgs.version = pi.version;
  text = ''
    ${initialization}

    # MCP servers and skills merge on every launch where the agent directory
    # is usable (they are not gateway-dependent); gateway models and defaults
    # follow when the gateway is enabled. The step warns and skips rather than
    # block Pi itself when the directory cannot be written (e.g. HOME is
    # unusable), and only invalid JSON in an existing user file aborts. The
    # empty key-env for gateway-less profiles disables the gateway work.
    agent_dir="''${PI_CODING_AGENT_DIR:-''${HOME:-}/.pi/agent}"
    if [ -n "''${PI_CODING_AGENT_DIR:-}''${HOME:-}" ]; then
      cache="''${XDG_CACHE_HOME:-''${HOME:-}}/agent-distro/pi/${builtins.hashString "sha256" (toString config)}/models.json"
      PYTHONPATH=${../../lib} ${python3.interpreter} ${./pi-state.py} "$agent_dir" ${config} ${lib.optionalString (gateway != null) (lib.escapeShellArg gateway.keyEnv)} "$cache" ${curl}/bin/curl
    fi

    exec ${lib.getExe pi} "$@"
  '';
}
