# Codex owns marketplace registration, installation, and its persistent state.
# Portable plugin contents and provider policy stay outside this adapter.
{ pkgs, plugins, gateway, package, profileName }:
let
  inherit (pkgs) lib callPackage writeShellApplication runCommand jq python3;
  codex = package;
  marketplaceName = "${profileName}-ai";

  # Codex loads the original directory itself; the description only supplies
  # its validated name, so an invalid manifest fails here as it does for Claude.
  readPlugin = callPackage ../../lib/read-plugin.nix { };
  marketplace = runCommand "codex-${marketplaceName}-marketplace" { nativeBuildInputs = [ jq ]; } ''
    mkdir -p "$out/.agents/plugins"
    touch entries.json "$out/plugin-ids"
    for description in ${lib.escapeShellArgs (map (plugin: toString (readPlugin plugin)) plugins)}; do
      plugin=$(jq -er '.root' "$description")
      name=$(jq -er '.manifest.name' "$description")
      ln -s "$plugin" "$out/$name"
      jq -n --arg name "$name" '{
        name: $name,
        source: {source: "local", path: ("./" + $name)},
        policy: {installation: "AVAILABLE", authentication: "ON_INSTALL"},
        category: "Productivity"
      }' >> entries.json
      printf '%s\n' "$name@${marketplaceName}" >> "$out/plugin-ids"
    done
    jq -s --arg name ${lib.escapeShellArg marketplaceName} '{name: $name, plugins: .}' entries.json > "$out/.agents/plugins/marketplace.json"
  '';
in
writeShellApplication {
  name = "codex";
  runtimeInputs = [ jq python3 ];
  derivationArgs.version = codex.version;
  text = ''
    # The prelude hides reasoning blocks through this helper; see it for when
    # the default is skipped.
    export CODEX_REASONING_SCRIPT=${./reasoning-defaults.py}
  '' + builtins.readFile ./session-defaults.sh + lib.optionalString (plugins != [ ]) ''
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
    exec ${lib.getExe codex} "$@"
  '';
}
