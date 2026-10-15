# Codex owns marketplace registration, installation, and its persistent state.
# Portable plugin contents and provider policy stay outside this adapter.
#
# The profiles' plugins reach Codex as one-launch marketplaces: src/harness/codex.ts
# registers each in its own install cache and passes the `-c` overrides that
# enable it, so nothing of a profile is written to config.toml.
{ pkgs, nixpkgs, package }:
let
  inherit (pkgs) lib writeShellApplication;
  codex = package;

  runtime = import ../../lib/runtime.nix pkgs;
  launchPlugins = runtime.launchPlugins (runtime.info nixpkgs // {
    harness = "codex";
    codex = lib.getExe codex;
  });
in
writeShellApplication {
  name = "codex";
  derivationArgs.version = codex.version;
  text = builtins.readFile ./session-defaults.sh + ''
    # The profiles in effect and their packages. Per-launch -c overrides: their
    # plugins enabled.
    ${launchPlugins}
    eval "set -- $launched \"\$@\""
    exec ${lib.getExe codex} "$@"
  '';
}
