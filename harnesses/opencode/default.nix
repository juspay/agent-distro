# A session config composes with the user's global and project settings, and
# carries the plugin that fills in the profile's provider.
{ pkgs, nixpkgs, package }:
let
  inherit (pkgs) lib writeShellApplication runCommand writeText gum;
  opencode = package;

  name = "opencode";
  # The vendored opencode-plugin-litellm, in the session config of every
  # launch. It discovers the models a LiteLLM server serves and reads
  # LITELLM_API_KEY. OpenCode takes a local plugin as a directory it finds
  # `index`/`server` in, so the config names the pin's `src`, not the package
  # root whose entry is behind `exports`.
  plugin = "${(import ./npins).opencode-plugin-litellm { inherit pkgs; }}/src";
  runtime = import ../../lib/runtime.nix pkgs;
  config = runCommand "${name}-config" { } ''
    ${runtime.script "harness/opencode.ts"} "$out" ${writeText "${name}-args.json" (builtins.toJSON (runtime.launcherInputs // {
      inherit plugin;
      descriptions = [ ];
    }))}
  '';
  launchPlugins = runtime.launchPlugins (runtime.info nixpkgs // {
    harness = "opencode";
    inherit name;
    config = "${config}";
  });
in
writeShellApplication {
  inherit name;
  derivationArgs.version = opencode.version;
  text = ''
    # The profiles in effect and their packages, and this config, with their
    # plugins merged into it.
    ${launchPlugins}
    config=$launched
    ${import ../../lib/prompt-secrets.nix { inherit gum; }}
    # The profile's `settings.opencode`, over the session config: a provider
    # it names, and the models it points at. Written by content, so a launch
    # never rewrites what another already cached.
    if [ -n "$profile_settings" ]; then
      if [ -z "''${XDG_CACHE_HOME:-}''${HOME:-}" ]; then
        echo 'agent-distro opencode: error: settings.opencode needs XDG_CACHE_HOME or HOME to be cached.' >&2
        exit 1
      fi
      config=$(${runtime.script "harness/opencode-settings.ts"} "$config" "$profile_settings" \
        "''${XDG_CACHE_HOME:-$HOME/.cache}/agent-distro/${name}/settings")
    fi
    if [ "''${OPENCODE_CONFIG+x}" = x ]; then
      echo 'agent-distro opencode: warning: replacing OPENCODE_CONFIG.' >&2
    fi
    export OPENCODE_CONFIG="$config"
    ${builtins.readFile ./session-defaults.sh}
    exec ${lib.getExe opencode} "$@"
  '';
}
