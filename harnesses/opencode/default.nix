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
      inherit schema;
      bash = runtimeShell;
      env = "${coreutils}/bin/env";
      descriptions = map (plugin: "${runtime.readPlugin plugin}") plugins;
    })}
  '';
  launchPlugins = runtime.launchPlugins {
    harness = "opencode";
    inherit schema name gateway profileName;
    bash = runtimeShell;
    env = "${coreutils}/bin/env";
    config = "${config}";
    profile = map (plugin: { description = "${runtime.readPlugin plugin}"; }) plugins;
  };
  # The gateway in effect over the session config, with the models it serves
  # cached beside it under the same name.
  initialization = ''
    if [ -n "$profile_gateway" ] && [ "''${AI_GATEWAY:-1}" != "0" ]; then
      ${import ../../lib/gateway-key.nix { inherit gum; }}
      cache="''${XDG_CACHE_HOME:-$HOME/.cache}/agent-distro/${name}"
      base=$(${runtime.script "gateway/config.ts"} opencode-${schema} "$profile_gateway" "$cache" "$config")
      models=''${base##*/}
      config=$(${runtime.script "gateway/models.ts"} "$base" "$cache/''${models%.json}/opencode.json" \
        ${curl}/bin/curl "$profile_gateway_key_env" ${shape})
    fi
  '';
in
assert builtins.elem schema [ "v1" "v2" ];
writeShellApplication {
  inherit name;
  derivationArgs.version = opencode.version;
  # `launched` and `profile_gateway*` are assigned by the launch's eval.
  excludeShellChecks = [ "SC2154" ];
  text = ''
    # The profile in effect and its packages, and this config, less the
    # plugins that profile or AGENT_DISTRO_PLUGINS replaces, plus their own.
    launch=$(${launchPlugins} ${config}/opencode.json)
    eval "$launch"
    config=$launched
    ${initialization}
    if [ "''${OPENCODE_CONFIG+x}" = x ]; then
      echo 'warning: agent-distro is replacing OPENCODE_CONFIG.' >&2
    fi
    export OPENCODE_CONFIG="$config"
    ${sessionDefaults}
    exec ${lib.getExe opencode} "$@"
  '';
}
