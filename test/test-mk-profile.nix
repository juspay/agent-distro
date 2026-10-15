# `mkProfile` without a VM: what a launch reads of a built profile — the
# `profile.json` naming it and its `reader`, one directory per plugin with that
# reader's description and a symlink to the plugin, and `bin/` from the
# profile's `packages`. A flake reference among the plugins has no place in a
# build, so it is refused; the same profile as a directory, a file and an
# attribute set is the one derivation.
{ pkgs, agent-distro, mkProfile }:
let
  inherit (pkgs) lib;
  runtime = import "${agent-distro}/lib/runtime.nix" pkgs;
  tool = pkgs.writeShellScriptBin "profile-tool" "echo tool";
  profile = {
    name = "mk-profile-check";
    description = "Built by mkProfile";
    plugins = [ ./fixtures/profile ];
    packages = _: [ tool ];
    env = { MK_PROFILE_CHECK = "1"; };
    settings.omp.modelRoles.default = "litellm/large";
  };
  # A profile may name no plugins at all: `env` and `settings` are the whole of
  # it, and its `plugins/` directory is still there (empty).
  pluginless = mkProfile {
    system = pkgs.stdenv.hostPlatform.system;
    profile = { name = "pluginless"; description = "No plugins"; env.PLAIN = "1"; };
  };
  build = mkProfile { system = pkgs.stdenv.hostPlatform.system; profile = profile; };
  asDirectory = mkProfile { system = pkgs.stdenv.hostPlatform.system; profile = ./fixtures/profile; };
  asFile = mkProfile { system = pkgs.stdenv.hostPlatform.system; profile = ./fixtures/profile/agent-distro.nix; };
  # A flake input is a source whose `outPath` is a store path; it is built too.
  asSource = mkProfile {
    system = pkgs.stdenv.hostPlatform.system;
    profile = { outPath = "${./fixtures/profile}"; };
  };
  referenced = builtins.tryEval (mkProfile {
    system = pkgs.stdenv.hostPlatform.system;
    profile = profile // { plugins = [ "github:juspay/skills" ]; };
  }).drvPath;
  reader = builtins.baseNameOf (toString runtime.tree);
  plugin = ./fixtures/profile;
in
assert !referenced.success;
pkgs.runCommand "mk-profile" { nativeBuildInputs = [ pkgs.jq ]; } ''
  built=${build}
  jq -e --arg reader ${lib.escapeShellArg reader} '
    .name == "mk-profile-check" and .description == "Built by mkProfile"
    and .env.MK_PROFILE_CHECK == "1" and .settings.omp.modelRoles.default == "litellm/large"
    and .reader == $reader' "$built/share/agent-distro/profile.json"
  # The reader names the runtime tree whose output the description is.
  test -f "$built/share/agent-distro/plugins/0/description.json"
  test -L "$built/share/agent-distro/plugins/0/root"
  test "$(readlink -f "$built/share/agent-distro/plugins/0/root")" = ${plugin}
  jq -e --arg root ${lib.escapeShellArg "${plugin}"} '.root == $root and .manifest.name == "fixture-profile"
    and .skills.hello == ["SKILL.md"]' "$built/share/agent-distro/plugins/0/description.json"
  # bin/ is the profile's packages.
  test "$("$built/bin/profile-tool")" = tool
  # A directory, a file, a source and the attribute set are the same profile.
  for other in ${asDirectory} ${asFile} ${asSource}; do
    test -f "$other/share/agent-distro/profile.json"
  done
  # A profile with no plugins has an empty `plugins/` and its env.
  test -d ${pluginless}/share/agent-distro/plugins
  test -z "$(ls -A ${pluginless}/share/agent-distro/plugins)"
  test "$(jq -r .env.PLAIN ${pluginless}/share/agent-distro/profile.json)" = 1
  # `bin/` holds the packages' commands and nothing else of their outputs.
  test "$(ls ${build}/bin)" = profile-tool
  touch "$out"
''
