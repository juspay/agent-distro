# Claude's plugin layout and CLI are local to this adapter. Shared sources stay
# portable; no provider initialization or persistent plugin install is needed.
{ pkgs, plugins, gateway, package }:
let
  inherit (pkgs) lib callPackage writeShellApplication runCommand runtimeShell jq python3 coreutils;
  claude = package;

  readPlugin = callPackage ../../lib/read-plugin.nix { };
  # Each step reads the validated description, never the plugin's own JSON, so
  # a Claude Code format change touches one step and a spec change none.
  manifest = description: runCommand "claude-plugin-manifest.json" { nativeBuildInputs = [ jq ]; } ''
    jq '.manifest | {name, version, description, author, homepage, repository, license, keywords}
        | with_entries(select(.value != null))' ${description} > "$out"
  '';
  # Only discovered skills, and only their in-root files. Materialized: Claude
  # rejects component symlinks outside its root.
  skills = description: runCommand "claude-plugin-skills" { nativeBuildInputs = [ jq ]; } ''
    mkdir "$out"
    root=$(jq -r .root ${description})
    jq --raw-output0 '.skills | to_entries[] | .key + "/" + .value[]' ${description} |
      while IFS= read -r -d "" file; do
        mkdir -p "$out/$(dirname "$file")"
        cp -L "$root/skills/$file" "$out/$file"
      done
  '';
  mcp = description: runCommand "claude-plugin-mcp" { } ''
    PYTHONPATH=${../../lib} ${python3.interpreter} ${./write-mcp.py} ${description} ${runtimeShell} ${coreutils}/bin/env "$out"
  '';
  adaptPlugin = plugin:
    let description = readPlugin plugin; in
    runCommand "claude-plugin" { } ''
      mkdir -p "$out/.claude-plugin"
      cp ${manifest description} "$out/.claude-plugin/plugin.json"
      cp -r ${skills description} "$out/skills"
      if [ -f ${mcp description}/mcp.json ]; then
        cp ${mcp description}/mcp.json "$out/.mcp.json"
      fi
    '';
  pluginFlags = lib.concatMapStringsSep " "
    (plugin: "--plugin-dir ${lib.escapeShellArg (toString (adaptPlugin plugin))}")
    plugins;
in
writeShellApplication {
  name = "claude";
  derivationArgs.version = claude.version;
  text = ''
    exec ${lib.getExe claude} ${pluginFlags} "$@"
  '';
}
