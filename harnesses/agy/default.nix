# The Antigravity CLI reads plugins only from its home: src/harness/agy.ts
# links each into `~/.gemini/config/plugins/` for the launch, and takes it back
# at the next one.
{ pkgs, name, package, launchPlugins }:
let
  inherit (pkgs) lib writeShellApplication;
  agy = package;
in
writeShellApplication {
  inherit name;
  derivationArgs.version = agy.version;
  text = ''
    # The profiles in effect, their env and packages, and their plugins and
    # AGENT_DISTRO_PLUGINS', linked where agy reads them; nothing is added to
    # its command line.
    ${launchPlugins { }}
    exec ${lib.getExe agy} "$@"
  '';
}
