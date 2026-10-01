# A session config composes with the user's global and project settings.
{ pkgs, plugins, gateway, package }:
let
  inherit (pkgs) lib callPackage writeShellApplication runCommand writeText runtimeShell python3 coreutils curl gum;
  opencode = package;
  schema = "v2";

  name = if schema == "v2" then "opencode2" else "opencode";
  readPlugin = callPackage ../../lib/read-plugin.nix { };
  config = runCommand "${name}-config" { } ''
    PYTHONPATH=${../../lib} ${python3.interpreter} ${./write-config.py} ${schema} "$out" ${runtimeShell} ${coreutils}/bin/env ${writeText "gateway.json" (builtins.toJSON gateway)} ${lib.escapeShellArgs (map (plugin: toString (readPlugin plugin)) plugins)}
  '';
  initialization = lib.optionalString (gateway != null) ''
    if [ "''${AI_GATEWAY:-1}" != "0" ]; then
      ${import ../../lib/gateway-key.nix { inherit gum gateway; }}
      config=$(${python3.interpreter} ${../../lib/gateway_models.py} ${config}/gateway.json  \
        "''${XDG_CACHE_HOME:-$HOME/.cache}/agent-distro/${name}/${builtins.hashString "sha256" (toString config)}/opencode.json" \
        ${curl}/bin/curl ${lib.escapeShellArg gateway.keyEnv} ${./gateway-shape.json})
    fi
  '';
in
assert builtins.elem schema [ "v1" "v2" ];
writeShellApplication {
  inherit name;
  derivationArgs.version = opencode.version;
  text = ''
    config=${config}/opencode.json
    ${initialization}
    if [ "''${OPENCODE_CONFIG+x}" = x ]; then
      echo 'warning: agent-distro is replacing OPENCODE_CONFIG.' >&2
    fi
    export OPENCODE_CONFIG="$config"
    ${lib.optionalString (schema == "v2") (builtins.readFile ./session-defaults.sh)}
    exec ${lib.getExe opencode} "$@"
  '';
}
