# Codex owns marketplace registration, installation, and its persistent state.
# Portable plugin contents and provider policy stay outside this adapter.
{ pkgs, plugins, info, package }:
let
  inherit (pkgs) lib writeShellApplication runCommand writeText runtimeShell coreutils jq;
  codex = package;
  marketplaceName = "${info.default}-ai";

  runtime = import ../../lib/runtime.nix pkgs;
  inherit (runtime) readPlugin script;
  # Codex reads the plugin's own `mcp.json` and starts its stdio servers in the
  # plugin root, as the spec requires. A built-in plugin's servers must run in
  # the launch directory like every other plugin's, so the marketplace carries a
  # copy whose servers go through generated launchers — the same translation the
  # adapter applies to AGENT_DISTRO_PLUGINS at launch.
  adaptPlugin = plugin: runCommand "codex-plugin" { } ''
    ${script "plugin/write-spec-plugin.ts"} "$out" ${writeText "codex-plugin-args.json" (builtins.toJSON {
      bash = runtimeShell;
      env = "${coreutils}/bin/env";
      description = "${readPlugin plugin}";
    })}
  '';
  marketplace = runCommand "codex-${marketplaceName}-marketplace" { nativeBuildInputs = [ jq ]; } ''
    mkdir -p "$out/.agents/plugins"
    touch entries.json "$out/plugin-ids"
    ${lib.concatMapStrings (plugin: ''
      name=$(jq -er '.manifest.name' ${readPlugin plugin})
      ln -s ${adaptPlugin plugin} "$out/$name"
      jq -n --arg name "$name" '{
        name: $name,
        source: {source: "local", path: ("./" + $name)},
        policy: {installation: "AVAILABLE", authentication: "ON_INSTALL"},
        category: "Productivity"
      }' >> entries.json
      printf '%s\n' "$name@${marketplaceName}" >> "$out/plugin-ids"
    '') plugins}
    jq -s --arg name ${lib.escapeShellArg marketplaceName} '{name: $name, plugins: .}' entries.json > "$out/.agents/plugins/marketplace.json"
  '';
  launchPlugins = runtime.launchPlugins {
    harness = "codex";
    inherit info;
    codex = lib.getExe codex;
    marketplace = marketplaceName;
    bash = runtimeShell;
    env = "${coreutils}/bin/env";
    profile = map (plugin: { description = "${readPlugin plugin}"; }) plugins;
  };
in
writeShellApplication {
  name = "codex";
  runtimeInputs = [ jq ];
  derivationArgs.version = codex.version;
  text = builtins.readFile ./session-defaults.sh + lib.optionalString (plugins != [ ]) ''
    # The name stays fixed, but its store path changes between builds. Use the
    # native installer only when that path changes, preserving disabled plugins
    # on steady-state launches as well as unrelated config and auth.
    marketplace=${marketplace}
    if ! registered=$(${lib.getExe codex} plugin marketplace list --json \
      | jq -r --arg n ${lib.escapeShellArg marketplaceName} '.marketplaces[] | select(.name == $n) | .root'); then
      # Another broken marketplace can make listing fail even when ours is absent.
      # Until it is repaired, each launch reinstalls ours and re-enables its plugins.
      ${lib.getExe codex} plugin marketplace remove ${lib.escapeShellArg marketplaceName} >/dev/null || true
      registered=""
    fi
    if [ "$registered" != "$marketplace" ] || [ ! -d "$registered" ]; then
      if [ -n "$registered" ]; then
        ${lib.getExe codex} plugin marketplace remove ${lib.escapeShellArg marketplaceName} >/dev/null
      fi
      ${lib.getExe codex} plugin marketplace add "$marketplace" >/dev/null
      while IFS= read -r plugin; do
        ${lib.getExe codex} plugin add "$plugin" >/dev/null
      done < "$marketplace/plugin-ids"
    fi
  '' + ''
    # The profile in effect and its packages. Per-launch -c overrides: the
    # plugins of a profile other than the built-in one and of
    # AGENT_DISTRO_PLUGINS enabled, the built-in plugins they replace disabled.
    ${launchPlugins}
    eval "set -- $launched \"\$@\""
    exec ${lib.getExe codex} "$@"
  '';
}
