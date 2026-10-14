# A session config composes with the user's global and project settings, and
# the gateway's provider with the plugin that fills it in.
{ pkgs, plugins, info, package }:
let
  inherit (pkgs) lib writeShellApplication runCommand writeText gum;
  opencode = package;

  name = "opencode";
  # The vendored opencode-plugin-litellm, which the gateway config names. It
  # discovers the models the gateway serves and reads LITELLM_API_KEY. OpenCode
  # takes a local plugin as a directory it finds `index`/`server` in, so the
  # config names the pin's `src`, not the package root whose entry is behind
  # `exports`.
  plugin = "${(import ./npins).opencode-plugin-litellm { inherit pkgs; }}/src";
  runtime = import ../../lib/runtime.nix pkgs;
  config = runCommand "${name}-config" { } ''
    ${runtime.script "harness/opencode.ts"} "$out" ${writeText "${name}-args.json" (builtins.toJSON (runtime.launcherInputs // {
      descriptions = map (plugin: "${runtime.readPlugin plugin}") plugins;
    }))}
  '';
  launchPlugins = runtime.launchPlugins {
    harness = "opencode";
    inherit name info;
    config = "${config}";
    profile = map (plugin: { description = "${runtime.readPlugin plugin}"; }) plugins;
  };
  # The gateway in effect over the session config, written beside it in the
  # cache: the provider that plugin fills in, and the plugin itself.
  initialization = ''
    if [ -n "$profile_gateway" ] && [ "''${AI_GATEWAY:-1}" != "0" ]; then
      ${import ../../lib/gateway-key.nix { inherit gum; }}
      # The plugin reads LITELLM_API_KEY, whatever the profile calls the key.
      export LITELLM_API_KEY="''${!profile_gateway_key_env}"
      cache="''${XDG_CACHE_HOME:-$HOME/.cache}/agent-distro/${name}"
      config=$(${runtime.script "gateway/config.ts"} opencode "$profile_gateway" "$cache" "$config" "${plugin}")
    fi
  '';
in
writeShellApplication {
  inherit name;
  derivationArgs.version = opencode.version;
  text = ''
    # The profile in effect and its packages, and this config, less the
    # plugins that profile or AGENT_DISTRO_PLUGINS replaces, plus their own.
    ${launchPlugins}
    config=$launched
    ${initialization}
    if [ "''${OPENCODE_CONFIG+x}" = x ]; then
      echo 'agent-distro opencode: warning: replacing OPENCODE_CONFIG.' >&2
    fi
    export OPENCODE_CONFIG="$config"
    ${builtins.readFile ./session-defaults.sh}
    exec ${lib.getExe opencode} "$@"
  '';
}
