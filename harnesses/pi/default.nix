# Pi's subcommands require resources in settings, not prepended CLI flags.
{ pkgs, plugins, info, package }:
let
  inherit (pkgs) lib writeShellApplication runCommand writeText runtimeShell coreutils curl gum;
  pi = package;

  runtime = import ../../lib/runtime.nix pkgs;
  config = runCommand "pi-config" { } ''
    ${runtime.script "harness/pi.ts"} write-config "$out" ${writeText "pi-args.json" (builtins.toJSON {
      bash = runtimeShell;
      env = "${coreutils}/bin/env";
      descriptions = map (plugin: "${runtime.readPlugin plugin}") plugins;
    })}
  '';
  launchPlugins = runtime.launchPlugins {
    harness = "pi";
    inherit info;
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
    # The profile in effect and its packages, and its fragment, less the
    # plugins that profile or AGENT_DISTRO_PLUGINS replaces, plus their own;
    # loading plugins other than the built-in ones fails without a home to
    # merge them into.
    ${launchPlugins}
    fragment=$launched
    if [ -n "''${PI_CODING_AGENT_DIR:-}''${HOME:-}" ]; then
      agent_dir="''${PI_CODING_AGENT_DIR:-''${HOME:-}/.pi/agent}"
      gateway=()
      if [ -n "$profile_gateway" ] && [ "''${AI_GATEWAY:-1}" != "0" ]; then
        # The gateway in effect as Pi's provider, with the models it serves
        # cached beside it under the same name.
        cache="''${XDG_CACHE_HOME:-''${HOME:-$agent_dir}/.cache}/agent-distro/pi"
        base=$(${runtime.script "gateway/config.ts"} pi "$profile_gateway" "$cache")
        gateway=("$base")
      fi
      status=0
      ${runtime.script "harness/pi.ts"} merge-state --check "$agent_dir" "$fragment" "''${gateway[@]}" || status=$?
      if [ "$status" = 1 ]; then exit 1; fi
      if [ "$status" = 2 ] && [ "$fragment" != ${config}/config.json ]; then
        echo 'Pi: cannot load AGENT_DISTRO_PLUGINS: the agent directory cannot be written.' >&2
        exit 1
      fi
      if [ "$status" = 0 ]; then
        if [ "''${#gateway[@]}" != 0 ]; then
          ${import ../../lib/gateway-key.nix { inherit gum; }}
          models=''${base##*/}
          cached=$(${runtime.script "gateway/models.ts"} "$base" "$cache/''${models%.json}/models.json" \
            ${curl}/bin/curl "$profile_gateway_key_env" ${./gateway-shape.json})
          gateway=("$cached")
        fi
        ${runtime.script "harness/pi.ts"} merge-state --merge "$agent_dir" "$fragment" "''${gateway[@]}"
      fi
    else
      echo 'Pi: warning: HOME and PI_CODING_AGENT_DIR are unset; skipping config merges.' >&2
    fi
    exec ${lib.getExe pi} "$@"
  '';
}
