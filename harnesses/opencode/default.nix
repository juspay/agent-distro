# A session config composes with the user's global and project settings.
# OpenCode v2 reuses this adapter with its own schema, shape and session setup.
{ pkgs, plugins, gateway, package, profileName, schema ? "v1", shape ? ./gateway-shape.json, sessionDefaults ? "" }:
let
  inherit (pkgs) lib writeShellApplication runCommand writeText runtimeShell coreutils curl gum;
  opencode = package;

  name = if schema == "v2" then "opencode2" else "opencode";
  runtime = import ../../lib/runtime.nix pkgs;
  config = runCommand "${name}-config" { } ''
    ${runtime.script "harness/opencode.ts"} "$out" ${writeText "${name}-args.json" (builtins.toJSON {
      inherit schema gateway;
      bash = runtimeShell;
      env = "${coreutils}/bin/env";
      descriptions = map (plugin: "${runtime.readPlugin plugin}") plugins;
    })}
  '';
  initialization = lib.optionalString (gateway != null) ''
    if [ "''${AI_GATEWAY:-1}" != "0" ]; then
      ${import ../../lib/gateway-key.nix { inherit gum gateway; }}
      config=$(${runtime.script "gateway/models.ts"} ${config}/gateway.json \
        "''${XDG_CACHE_HOME:-$HOME/.cache}/agent-distro/${name}/${builtins.hashString "sha256" (toString config)}/opencode.json" \
        ${curl}/bin/curl ${lib.escapeShellArg gateway.keyEnv} ${shape})
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
    ${sessionDefaults}
    exec ${lib.getExe opencode} "$@"
  '';
}
