# A session config composes with the user's global and project settings.
{ lib, callPackage, writeShellApplication, runCommand, writeText, runtimeShell
, python3, coreutils, curl, gum, opencode, plugins, gateway ? null }:
let
  readPlugin = callPackage ../../lib/read-plugin.nix { };
  config = runCommand "opencode-config" { } ''
    PYTHONPATH=${../../lib} ${python3.interpreter} ${./write-config.py} "$out" ${runtimeShell} ${coreutils}/bin/env ${writeText "gateway.json" (builtins.toJSON gateway)} ${lib.escapeShellArgs (map (plugin: toString (readPlugin plugin)) plugins)}
  '';
  initialization = lib.optionalString (gateway != null) ''
    if [ "''${AI_GATEWAY:-1}" != "0" ]; then
      ${import ../gateway-key.nix { inherit gum gateway; }}
      config=$(${python3.interpreter} ${./cache-config.py} ${config}/gateway.json  \
        "''${XDG_CACHE_HOME:-$HOME/.cache}/agent-distro/opencode/${builtins.hashString "sha256" (toString config)}/opencode.json" \
        ${curl}/bin/curl ${lib.escapeShellArg gateway.keyEnv})
    fi
  '';
in
writeShellApplication {
  name = "opencode";
  derivationArgs.version = opencode.version;
  text = ''
    config=${config}/opencode.json
    ${initialization}
    if [ "''${OPENCODE_CONFIG+x}" = x ]; then
      echo 'warning: agent-distro is replacing OPENCODE_CONFIG.' >&2
    fi
    export OPENCODE_CONFIG="$config"
    exec ${lib.getExe opencode} "$@"
  '';
}
